"""Chatbot router – LLM-powered shopping assistant using catalog DB tables.

Uses HuggingFace Router API (OpenAI-compatible) for natural-language answers.
Pulls cart data plus catalog metadata from products/product_prices/product_discounts.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import inspect, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.dependencies import app_state

router = APIRouter(tags=["chatbot"])

# ---------------------------------------------------------------------------
# LLM / Tool Use configuration
# ---------------------------------------------------------------------------

_MAX_CHAT_HISTORY_TURNS = 5   # 최근 5턴 (user+assistant 쌍) 유지
_MAX_TOOL_ROUNDS = 3          # tool 호출 최대 라운드

SYSTEM_PROMPT = """\
당신은 '장보고' 마트의 AI 쇼핑 도우미입니다.

## 역할
- 고객의 장바구니 관리, 상품 검색, 가격·할인·영양정보 안내, 매장 코너 위치 안내를 담당합니다.
- 항상 친절하고 자연스러운 한국어로 답변하세요.

## 답변 규칙
1. **DB에 있는 정보만** 근거로 답변하세요. 추측하거나 지어내지 마세요.
2. DB에서 확인되지 않는 내용은 "현재 DB에 해당 정보가 없습니다"라고 명확히 알려주세요.
3. 가격 미등록 상품은 "가격 정보가 아직 등록되지 않았습니다"라고 안내하세요.
4. 금액에는 항상 쉼표와 '원' 단위를 붙여주세요 (예: 1,500원).
5. 답변은 간결하되 필요한 정보는 빠짐없이 포함하세요.
6. 여러 상품을 비교할 때는 번호 목록을 사용하세요.
7. 이전 대화 맥락을 참고하되, 새 질문의 의도가 명확하면 그에 집중하세요.

## 도구(tool) 사용
- 상품 검색, 상세 조회, 매장 위치 조회 도구가 제공됩니다.
- 질문에 답하기 위해 필요한 도구를 적극적으로 호출하세요.
- 도구 결과를 바탕으로 자연스럽게 종합 답변을 작성하세요.
"""

# 소형 로컬 모델(4B 등)용 간결한 시스템 프롬프트
SYSTEM_PROMPT_LOCAL = """\
당신은 '장보고' 마트의 쇼핑 도우미입니다.
제공된 DB 정보만 근거로 친절하게 한국어로 답변하세요.
DB에 없는 정보는 "해당 정보가 없습니다"라고 답하세요.
금액은 쉼표와 원 단위를 사용하세요 (예: 1,500원).
상품명에 포함된 브랜드, 중량 정보도 함께 안내하세요.
"""

# ---------------------------------------------------------------------------
# Cart action helpers
# ---------------------------------------------------------------------------

_ADD_TOKENS = ("추가", "담아", "더해", "넣어", "넣어줘", "담아줘")
_REMOVE_TOKENS = ("빼", "삭제", "제거", "빼줘", "빼 줘", "빼주세요")
_CLEAR_TOKENS = (
    "비워",
    "비워줘",
    "비워 줘",
    "초기화",
    "모두 삭제",
    "전부 삭제",
    "전체 삭제",
    "장바구니 비워",
    "장바구니 비워줘",
    "장바구니 초기화",
)
_SELECT_PREFIX = "__select__:"
_POLITE_TOKENS = ("줘", "주세요", "해줘", "해 주세요", "좀", "개", "개만", "개요", "개씩")
_REFERENCE_TOKENS = ("그거", "그것", "그 상품", "그 제품", "이거", "이것", "이 상품", "이 제품", "저거", "저것")


def _extract_quantity(question: str) -> tuple[int, str]:
    match = re.search(r"(\d+)\s*(개|개씩|개만|pcs|개요)", question)
    if match:
        qty = max(1, int(match.group(1)))
        cleaned = question.replace(match.group(0), " ")
        return qty, cleaned

    word_map = [
        ("한 개", 1),
        ("한개", 1),
        ("하나", 1),
        ("한", 1),
        ("두", 2),
        ("둘", 2),
        ("세", 3),
        ("셋", 3),
        ("네", 4),
        ("넷", 4),
    ]
    for key, value in word_map:
        if key in question:
            return value, question.replace(key, " ")

    return 1, question


def _normalize_text(text: str) -> str:
    return re.sub(r"[^0-9a-zA-Z가-힣]", "", text or "").lower()


def _label_display(label: str) -> str:
    if "_" in label:
        prefix, suffix = label.split("_", 1)
        if prefix.isdigit() and suffix:
            return suffix
    return label


def _find_label_in_cart(question: str, billing_items: dict[str, int]) -> str | None:
    normalized_question = _normalize_text(question)
    if not normalized_question:
        return None

    for label in billing_items.keys():
        display = _label_display(label)
        normalized_display = _normalize_text(display)
        if normalized_display and (
            normalized_display in normalized_question or normalized_question in normalized_display
        ):
            return label

    return None


def _find_cart_label(
    db: Session,
    question: str,
    billing_items: dict[str, int],
    require_in_cart: bool = False,
) -> tuple[str | None, str | None]:
    normalized = re.sub(r"\s+", " ", question).strip()

    label = _find_label_in_cart(normalized, billing_items)
    if label:
        return label, _label_display(label)

    for label in billing_items.keys():
        if label and label in normalized:
            return label, label

    item_no_match = re.search(r"\b(\d{4,})\b", normalized)
    if item_no_match:
        item_no = item_no_match.group(1)
        row = db.execute(
            text("SELECT id, item_no, product_name FROM products WHERE item_no = :v LIMIT 1"),
            {"v": item_no},
        ).mappings().first()
        if row:
            for label in billing_items.keys():
                if label.startswith(item_no):
                    return label, row["product_name"]
            if require_in_cart:
                return None, None
            return f"{row['item_no']}_{row['product_name']}", row["product_name"]

    cleaned = _clean_keyword(normalized)
    if not cleaned:
        return None, None

    row = db.execute(
        text(
            "SELECT item_no, product_name FROM products "
            "WHERE product_name LIKE :kw ORDER BY LENGTH(product_name) DESC LIMIT 1"
        ),
        {"kw": f"%{cleaned}%"},
    ).mappings().first()
    if row:
        for label in billing_items.keys():
            if row["product_name"] in label:
                return label, row["product_name"]
            normalized_label = _normalize_text(label)
            normalized_name = _normalize_text(row["product_name"])
            if normalized_name and normalized_name in normalized_label:
                return label, row["product_name"]
        if require_in_cart:
            return None, None
        return f"{row['item_no']}_{row['product_name']}", row["product_name"]

    return None, None


def _find_by_item_no(db: Session, question: str) -> tuple[str | None, str | None]:
    item_no_match = re.search(r"\b(\d{4,})\b", question)
    if not item_no_match:
        return None, None

    item_no = item_no_match.group(1)
    row = db.execute(
        text("SELECT item_no, product_name FROM products WHERE item_no = :v LIMIT 1"),
        {"v": item_no},
    ).mappings().first()

    if not row:
        return None, None

    label = f"{row['item_no']}_{row['product_name']}"
    return label, str(row["product_name"])


def _find_candidate_products(db: Session, keyword: str) -> list[dict[str, str]]:
    cleaned = _clean_keyword(keyword)
    if not cleaned or len(cleaned) < 2:
        return []

    rows = db.execute(
        text(
            "SELECT item_no, product_name FROM products "
            "WHERE product_name LIKE :kw ORDER BY LENGTH(product_name) ASC LIMIT 8"
        ),
        {"kw": f"%{cleaned}%"},
    ).mappings().all()

    return [
        {
            "item_no": str(row["item_no"]),
            "product_name": str(row["product_name"]),
            "label": f"{row['item_no']}_{row['product_name']}",
        }
        for row in rows
    ]


def _find_cart_candidates(keyword: str, billing_items: dict[str, int]) -> list[dict[str, str]]:
    cleaned = _clean_keyword(keyword)
    if not cleaned or len(cleaned) < 2:
        return []

    normalized = _normalize_text(cleaned)
    if not normalized:
        return []

    candidates: list[dict[str, str]] = []
    for label in billing_items.keys():
        display = _label_display(label)
        if normalized in _normalize_text(display):
            item_no = None
            if "_" in label:
                prefix, _ = label.split("_", 1)
                if prefix.isdigit():
                    item_no = prefix
            candidates.append(
                {
                    "item_no": item_no or "",
                    "product_name": display,
                    "label": label,
                }
            )

    return candidates[:8]


def _detect_cart_action(question: str) -> str | None:
    if any(token in question for token in _CLEAR_TOKENS):
        return "clear"
    if any(token in question for token in _ADD_TOKENS):
        return "add"
    if any(token in question for token in _REMOVE_TOKENS):
        return "remove"
    return None


def _clean_keyword(text: str) -> str:
    cleaned = text
    tokens = list(_ADD_TOKENS + _REMOVE_TOKENS + _POLITE_TOKENS + _CLEAR_TOKENS)
    tokens.sort(key=len, reverse=True)
    for token in tokens:
        cleaned = cleaned.replace(token, " ")
    cleaned = re.sub(r"[0-9]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()



def _read_hf_token_from_env_file(path: Path) -> str | None:
    if not path.is_file():
        return None

    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip("'").strip('"')
            if key in {"HF_TOKEN", "HUGGINGFACE_HUB_TOKEN"} and value:
                return value
    except OSError:
        return None

    return None


def _get_hf_token() -> str | None:
    """Resolve HF token from env first, then common .env fallback files."""
    token = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_HUB_TOKEN")
    if token:
        return token.strip()

    token_file = os.getenv("HF_TOKEN_FILE")
    if token_file:
        token_from_file = _read_hf_token_from_env_file(Path(token_file).expanduser())
        if token_from_file:
            return token_from_file

    backend_dir = Path(__file__).resolve().parents[1]
    app_dir = backend_dir.parent
    project_root = app_dir.parent

    env_candidates = [
        project_root / ".env",
        app_dir / ".env",
        Path.cwd() / ".env",
    ]

    for env_path in env_candidates:
        token_from_file = _read_hf_token_from_env_file(env_path)
        if token_from_file:
            return token_from_file

    return None
# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------

class ChatbotRequest(BaseModel):
    question: str
    session_id: str | None = None


class ProductMeta(BaseModel):
    name: str
    quantity: int
    product_name: str | None = None
    item_no: str | None = None
    unit_price: int | None = None
    line_total: int = 0
    price_found: bool = False


# ---------------------------------------------------------------------------
# DB helpers – reuse products / product_prices tables
# ---------------------------------------------------------------------------

def _find_product_row(db: Session, label: str) -> dict[str, Any] | None:
    """Try to find a product by item_no prefix or product_name."""
    name = (label or "").strip()
    if not name:
        return None

    # Try item_no_productname format (e.g. "1234_코카콜라")
    if "_" in name:
        prefix, suffix = name.split("_", 1)
        if prefix.isdigit():
            row = db.execute(
                text("SELECT id, item_no, barcd, product_name FROM products WHERE item_no = :v ORDER BY id DESC LIMIT 1"),
                {"v": prefix},
            ).mappings().first()
            if row:
                return dict(row)

    # Try exact product_name match
    row = db.execute(
        text("SELECT id, item_no, barcd, product_name FROM products WHERE product_name = :v ORDER BY id DESC LIMIT 1"),
        {"v": name},
    ).mappings().first()
    if row:
        return dict(row)

    # Try raw label as product_name
    row = db.execute(
        text("SELECT id, item_no, barcd, product_name FROM products WHERE product_name = :v ORDER BY id DESC LIMIT 1"),
        {"v": label},
    ).mappings().first()
    if row:
        return dict(row)

    return None


def _find_latest_price(db: Session, product_id: int) -> int | None:
    """Return latest unit price (KRW) for the given product, or None."""
    row = db.execute(
        text(
            "SELECT price FROM product_prices "
            "WHERE product_id = :pid ORDER BY checked_at DESC, id DESC LIMIT 1"
        ),
        {"pid": product_id},
    ).mappings().first()
    return int(row["price"]) if row else None


def _catalog_available(db: Session) -> bool:
    """Check if catalog tables exist and are queryable."""
    try:
        db.execute(text("SELECT 1 FROM products LIMIT 1"))
        db.execute(text("SELECT 1 FROM product_prices LIMIT 1"))
        return True
    except SQLAlchemyError:
        return False


def _build_cart_meta(db: Session, billing_items: dict[str, int]) -> list[ProductMeta]:
    """Resolve billing labels to product metadata via products/product_prices."""
    if not billing_items:
        return []

    catalog_ok = _catalog_available(db)
    result: list[ProductMeta] = []

    for label, qty in billing_items.items():
        product_row: dict[str, Any] | None = None
        unit_price: int | None = None

        if catalog_ok:
            try:
                product_row = _find_product_row(db, label)
            except SQLAlchemyError:
                product_row = None

            if product_row:
                try:
                    unit_price = _find_latest_price(db, int(product_row["id"]))
                except SQLAlchemyError:
                    unit_price = None

        result.append(
            ProductMeta(
                name=label,
                quantity=qty,
                product_name=str(product_row["product_name"]) if product_row else None,
                item_no=str(product_row["item_no"]) if product_row else None,
                unit_price=unit_price,
                line_total=(unit_price or 0) * qty,
                price_found=unit_price is not None,
            )
        )

    return result


# ---------------------------------------------------------------------------
# Aggregate helpers
# ---------------------------------------------------------------------------

def _totals(products: list[ProductMeta]) -> dict[str, Any]:
    total_count = sum(p.quantity for p in products)
    total_price = sum(p.line_total for p in products)
    priced = sum(1 for p in products if p.price_found)
    unpriced = [p.name for p in products if not p.price_found]

    return {
        "total_count": total_count,
        "total_price": total_price,
        "priced_items": priced,
        "unpriced_items": unpriced,
    }


_CATALOG_STOPWORDS = {
    "상품",
    "정보",
    "성분",
    "현재",
    "기준",
    "관련",
    "알려줘",
    "알려",
    "보여줘",
    "보여",
    "뭐야",
    "뭐",
    "어떤",
    "있는",
    "대해",
    "가격",
    "할인",
    "할인율",
    "영양",
    "영양소",
    "영양정보",
    "영양성분",
    "칼로리",
    "열량",
    "단백질",
    "탄수화물",
    "지방",
    "포화지방",
    "트랜스지방",
    "당류",
    "당",
    "나트륨",
    "장바구니",
    "그리고",
    "또",
    "좀",
    "해줘",
    "주세요",
}
_DISCOUNT_QUERY_TOKENS = ("할인", "세일", "할인율", "할인가")
_PRICE_QUERY_TOKENS = ("가격", "비싼", "저렴", "최고가", "최저가", "금액", "얼마")
_LOCATION_QUERY_TOKENS = (
    "위치",
    "어디",
    "코너",
    "몇번",
    "몇 번",
    "어느 코너",
    "어느코너",
    "어디에",
    "location",
    "aisle",
)
_LOCATION_TERM_STOPWORDS = {
    "위치",
    "어디",
    "어디야",
    "어디에",
    "코너",
    "몇번",
    "몇",
    "번",
    "location",
    "aisle",
}
_NUTRITION_QUERY_TOKENS = (
    "영양",
    "영양소",
    "영양정보",
    "영양성분",
    "칼로리",
    "열량",
    "단백질",
    "탄수화물",
    "지방",
    "포화지방",
    "트랜스지방",
    "당류",
    "당",
    "나트륨",
)
_NUTRITION_RANK_QUERY_TOKENS = (
    "제일 높은",
    "가장 높은",
    "최고",
    "top",
    "탑",
    "순위",
    "랭킹",
)
_MAX_CATALOG_MATCH_ROWS = 8
_NUTRIENT_ALIAS_MAP: dict[str, tuple[str, ...]] = {
    "칼로리": ("칼로리", "열량", "에너지", "kcal", "calorie", "㎉"),
    "단백질": ("단백질", "protein"),
    "탄수화물": ("탄수화물", "탄수", "carbohydrate", "carb", "carbs"),
    "지방": ("지방", "총지방", "fat"),
    "포화지방": ("포화지방", "saturated"),
    "트랜스지방": ("트랜스지방", "trans"),
    "당류": ("당류", "총당류", "당", "당분", "sugar"),
    "나트륨": ("나트륨", "소듐", "sodium"),
}


def _compact_prompt_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (int, float, bool)):
        return value
    text_value = str(value).strip()
    if not text_value:
        return None
    if len(text_value) > 180:
        return f"{text_value[:177]}..."
    return text_value


def _json_for_prompt(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, default=str, indent=2)
    except Exception:
        return str(value)


def _table_columns(db: Session, table_name: str) -> list[str]:
    try:
        db_inspector = inspect(db.get_bind())
        raw_columns = db_inspector.get_columns(table_name)
    except Exception:
        return []

    valid: list[str] = []
    for col in raw_columns:
        name = str(col.get("name") or "").strip()
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            valid.append(name)
    return valid


def _strip_korean_particles(token: str) -> str:
    """한국어 조사/어미를 제거하여 핵심 명사만 추출.

    예: '스팸이랑' → '스팸', '동원리챔이랑' → '동원리챔',
        '새우깡은' → '새우깡', '콜라를' → '콜라'
    """
    # 긴 조사부터 매칭해야 "에서" 같은 2글자 조사가 먼저 걸림
    _PARTICLES = (
        "이랑", "에서", "하고", "으로", "부터", "까지", "에게", "한테",
        "처럼", "만큼", "대로", "보다", "같은", "말고", "에서는",
        "으로는", "이라", "이야", "이에요", "에는", "에도", "과는",
        "와는", "이랑은",
        "은", "는", "이", "가", "을", "를", "의", "에", "로", "와", "과",
        "도", "만", "요", "야",
    )
    for p in _PARTICLES:
        if token.endswith(p) and len(token) > len(p):
            stripped = token[: -len(p)]
            if len(stripped) >= 2:
                return stripped
    return token


def _extract_catalog_terms(question: str, limit: int = 4) -> list[str]:
    tokens = re.findall(r"[0-9]{3,}|[A-Za-z]{2,}|[가-힣]{2,}", question or "")
    terms: list[str] = []
    seen: set[str] = set()
    for raw in tokens:
        token = raw.strip()
        if not token:
            continue
        # 한국어 조사 제거: "스팸이랑" → "스팸", "동원리챔이랑" → "동원리챔"
        token = _strip_korean_particles(token)
        normalized = token.lower()
        if normalized in _CATALOG_STOPWORDS:
            continue
        if normalized in seen:
            continue
        seen.add(normalized)
        terms.append(token)

    # 긴 한글 토큰에서 핵심 서브스트링 추출 (브랜드/중량 제거)
    # 예: "매운새우깡90G" → "매운새우깡", "새우깡"
    extra: list[str] = []
    for term in list(terms):
        if len(term) < 4 or not re.search(r"[가-힣]", term):
            continue
        # 뒤쪽 용량 패턴 제거 (90G, 300ml 등)
        core = re.sub(r"\d+[gGmMlLkK]+[gGlL]?$", "", term).strip()
        if core and core != term and len(core) >= 2 and core.lower() not in seen:
            extra.append(core)
            seen.add(core.lower())
        # 앞쪽 브랜드 접두사 제거 시도 (2~3자 한글 브랜드 + 나머지 3자 이상)
        brand_match = re.match(r"^([가-힣]{2,3})([가-힣]{3,})", core or term)
        if brand_match:
            suffix = brand_match.group(2)
            if suffix.lower() not in seen and suffix.lower() not in _CATALOG_STOPWORDS:
                extra.append(suffix)
                seen.add(suffix.lower())

    terms.extend(extra)
    return terms[:limit]


def _query_catalog_products(
    db: Session,
    question: str,
    product_columns: list[str],
    limit: int = _MAX_CATALOG_MATCH_ROWS,
) -> tuple[list[dict[str, Any]], list[str]]:
    if not product_columns:
        return [], []

    terms = _extract_catalog_terms(question)
    safe_limit = max(1, min(limit, 20))

    preferred = [
        "item_no",
        "product_name",
        "barcd",
        "nutrition_info",
        "nutrition",
        "nutrients",
        "kcal",
        "calories",
        "protein",
        "carbohydrate",
        "fat",
        "sodium",
        "sugar",
        "category_l",
        "category_m",
        "category_s",
        "category",
        "brand",
        "manufacturer",
        "maker",
        "origin",
        "description",
        "desc",
        "spec",
        "specification",
        "unit",
    ]
    searchable = [col for col in preferred if col in product_columns]
    if not searchable:
        searchable = [
            col
            for col in product_columns
            if any(
                key in col.lower()
                for key in (
                    "name",
                    "item",
                    "bar",
                    "category",
                    "brand",
                    "maker",
                    "origin",
                    "desc",
                    "spec",
                    "unit",
                    "nutrition",
                    "nutri",
                    "kcal",
                    "calorie",
                    "protein",
                    "carb",
                    "fat",
                    "sodium",
                    "sugar",
                )
            )
        ]
    if not searchable:
        searchable = [product_columns[0]]

    params: dict[str, Any] = {}
    groups: list[str] = []
    for idx, term in enumerate(terms):
        like_key = f"kw_{idx}"
        params[like_key] = f"%{term}%"
        clauses = [f"p.`{col}` LIKE :{like_key}" for col in searchable]
        if "product_name" in product_columns:
            normalized_term = re.sub(r"[\s\-_]+", "", term)
            if normalized_term:
                norm_key = f"kw_norm_{idx}"
                params[norm_key] = f"%{normalized_term}%"
                clauses.append(
                    "REPLACE(REPLACE(REPLACE(p.`product_name`, ' ', ''), '-', ''), '_', '') "
                    f"LIKE :{norm_key}"
                )
        if term.isdigit() and "item_no" in product_columns:
            exact_key = f"item_no_{idx}"
            clauses.append(f"p.`item_no` = :{exact_key}")
            params[exact_key] = term
        groups.append("(" + " OR ".join(clauses) + ")")

    where_sql = f"WHERE {' AND '.join(groups)}" if groups else ""
    order_parts: list[str] = []
    for col in ("updated_at", "created_at", "id"):
        if col in product_columns:
            order_parts.append(f"p.`{col}` DESC")
    if not order_parts:
        order_parts.append(f"p.`{product_columns[0]}` DESC")

    params["limit"] = safe_limit * 2 if "item_no" in product_columns else safe_limit

    def _run_catalog_query(where_clause: str) -> list[dict[str, Any]]:
        sql = (
            "SELECT p.* "
            "FROM products p "
            f"{where_clause} "
            f"ORDER BY {', '.join(order_parts)} "
            "LIMIT :limit"
        )
        rows = db.execute(text(sql), params).mappings().all()
        return [dict(row) for row in rows]

    try:
        normalized_rows = _run_catalog_query(where_sql)
        if not normalized_rows and len(groups) > 1:
            fallback_where = f"WHERE {' OR '.join(groups)}"
            normalized_rows = _run_catalog_query(fallback_where)
        # FULLTEXT 폴백: LIKE 검색 결과 없을 때 ft_products_name_company 인덱스 활용
        if not normalized_rows and terms:
            ft_query = " ".join(f"+{t}*" for t in terms if len(t) >= 2)
            if ft_query:
                try:
                    ft_sql = (
                        "SELECT p.*, "
                        "MATCH(p.`product_name`, p.`company`) AGAINST(:ft IN BOOLEAN MODE) AS _ft_score "
                        "FROM products p "
                        "WHERE MATCH(p.`product_name`, p.`company`) AGAINST(:ft IN BOOLEAN MODE) "
                        "ORDER BY _ft_score DESC "
                        "LIMIT :limit"
                    )
                    ft_rows = db.execute(text(ft_sql), {"ft": ft_query, "limit": safe_limit}).mappings().all()
                    normalized_rows = [dict(r) for r in ft_rows]
                except SQLAlchemyError:
                    pass
    except SQLAlchemyError:
        return [], terms
    if "item_no" not in product_columns:
        return normalized_rows[:safe_limit], terms

    deduped: list[dict[str, Any]] = []
    seen_item_nos: set[str] = set()
    for row in normalized_rows:
        item_no = str(row.get("item_no") or "").strip()
        key = item_no if item_no else str(row.get("id") or "")
        if not key or key in seen_item_nos:
            continue
        seen_item_nos.add(key)
        deduped.append(row)
        if len(deduped) >= safe_limit:
            break

    return deduped, terms


def _latest_price_row(
    db: Session,
    product_id: int,
    price_columns: list[str],
) -> dict[str, Any]:
    if not price_columns:
        return {}
    if "product_id" not in price_columns or "price" not in price_columns:
        return {}

    select_cols = [
        col for col in (
            "id", "price", "currency", "source", "checked_at",
            "is_discounted", "discount_rate", "discount_amount", "created_at",
        )
        if col in price_columns
    ]
    if "price" not in select_cols:
        return {}

    order_cols = [col for col in ("checked_at", "created_at", "id") if col in price_columns]
    if not order_cols:
        order_cols = ["price"]

    sql = (
        f"SELECT {', '.join(f'`{col}`' for col in select_cols)} "
        "FROM product_prices "
        "WHERE `product_id` = :pid "
        f"ORDER BY {', '.join(f'`{col}` DESC' for col in order_cols)} "
        "LIMIT 1"
    )
    row = db.execute(text(sql), {"pid": int(product_id)}).mappings().first()
    return dict(row) if row else {}


def _latest_discount_row(
    db: Session,
    product_price_id: int,
    price_columns: list[str],
) -> dict[str, Any]:
    """product_prices 테이블에서 discount 컬럼 직접 조회 (product_discounts 제거됨)."""
    if not price_columns:
        return {}
    if not {"is_discounted", "discount_rate", "discount_amount"} & set(price_columns):
        return {}

    select_cols = [
        col for col in ("id", "is_discounted", "discount_rate", "discount_amount")
        if col in price_columns
    ]
    sql = (
        f"SELECT {', '.join(f'`{col}`' for col in select_cols)} "
        "FROM product_prices "
        "WHERE `id` = :ppid "
        "LIMIT 1"
    )
    row = db.execute(text(sql), {"ppid": int(product_price_id)}).mappings().first()
    return dict(row) if row else {}


def _catalog_summary(
    db: Session,
    product_columns: list[str],
    discount_columns: list[str],
) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    if not product_columns:
        return summary

    try:
        if "item_no" in product_columns:
            total_products = db.execute(
                text("SELECT COUNT(DISTINCT `item_no`) AS cnt FROM products")
            ).mappings().first()
        else:
            total_products = db.execute(
                text("SELECT COUNT(*) AS cnt FROM products")
            ).mappings().first()
        summary["total_products"] = int(total_products["cnt"]) if total_products else 0
    except SQLAlchemyError:
        pass

    for category_col in ("category_l", "category_m", "category_s", "category"):
        if category_col not in product_columns:
            continue
        try:
            category_row = db.execute(
                text(
                    f"SELECT COUNT(DISTINCT `{category_col}`) AS cnt "
                    "FROM products "
                    f"WHERE `{category_col}` IS NOT NULL AND TRIM(`{category_col}`) <> ''"
                )
            ).mappings().first()
            summary[f"{category_col}_count"] = int(category_row["cnt"]) if category_row else 0
        except SQLAlchemyError:
            continue

    if "is_discounted" in discount_columns:
        try:
            discount_row = db.execute(
                text(
                    "SELECT COUNT(*) AS cnt "
                    "FROM product_prices "
                    "WHERE `is_discounted` = 1"
                )
            ).mappings().first()
            summary["discount_rows"] = int(discount_row["cnt"]) if discount_row else 0
        except SQLAlchemyError:
            pass

    return summary


def _category_corner_snapshot(db: Session) -> dict[str, dict[str, Any]]:
    """category_corner_map에서 직접 조회 (store_corners 병합됨)."""
    map_columns = _table_columns(db, "category_corner_map")
    if not map_columns:
        return {}
    if not {"category_l", "corner_no"}.issubset(set(map_columns)):
        return {}

    try:
        rows = db.execute(
            text(
                "SELECT category_l, corner_no, corner_name "
                "FROM category_corner_map "
                "ORDER BY corner_no ASC, category_l ASC"
            )
        ).mappings().all()
    except SQLAlchemyError:
        return {}

    snapshot: dict[str, dict[str, Any]] = {}
    for row in rows:
        category = str(row.get("category_l") or "").strip()
        corner_no = row.get("corner_no")
        if not category or corner_no is None:
            continue
        corner_name = str(row.get("corner_name") or "").strip()
        snapshot[category] = {
            "corner_no": int(corner_no),
            "corner_name": corner_name or f"{int(corner_no)}번 코너",
        }
    return snapshot


def _discount_snapshot(
    db: Session,
    question: str,
    product_columns: list[str],
    price_columns: list[str],
) -> list[dict[str, Any]]:
    """할인 스냅샷: product_prices.is_discounted 직접 사용 (product_discounts 병합됨)."""
    if not any(token in question for token in _DISCOUNT_QUERY_TOKENS):
        return []
    required = {"id", "item_no", "product_name"}
    if not required.issubset(set(product_columns)):
        return []
    if not {"id", "product_id", "is_discounted"}.issubset(set(price_columns)):
        return []

    select_cols = ["p.`item_no` AS item_no", "p.`product_name` AS product_name"]
    if "discount_rate" in price_columns:
        select_cols.append("pp.`discount_rate` AS discount_rate")
    if "discount_amount" in price_columns:
        select_cols.append("pp.`discount_amount` AS discount_amount")

    order_terms: list[str] = []
    if "discount_rate" in price_columns:
        order_terms.append("COALESCE(pp.`discount_rate`, 0) DESC")
    if "discount_amount" in price_columns:
        order_terms.append("COALESCE(pp.`discount_amount`, 0) DESC")
    order_terms.append("p.`id` DESC")

    sql = (
        f"SELECT {', '.join(select_cols)} "
        "FROM products p "
        "JOIN product_prices pp ON pp.`product_id` = p.`id` "
        "WHERE pp.`is_discounted` = 1 "
        f"ORDER BY {', '.join(order_terms)} "
        "LIMIT :limit"
    )
    try:
        rows = db.execute(text(sql), {"limit": 8}).mappings().all()
    except SQLAlchemyError:
        return []

    deduped: list[dict[str, Any]] = []
    seen_item_nos: set[str] = set()
    for row in rows:
        item_no = str(row.get("item_no") or "").strip()
        if item_no and item_no in seen_item_nos:
            continue
        if item_no:
            seen_item_nos.add(item_no)
        compact = {
            key: _compact_prompt_value(value)
            for key, value in dict(row).items()
            if _compact_prompt_value(value) is not None
        }
        if compact:
            deduped.append(compact)
    return deduped[:5]


def _price_snapshot(
    db: Session,
    question: str,
    product_columns: list[str],
    price_columns: list[str],
) -> dict[str, list[dict[str, Any]]]:
    if not any(token in question for token in _PRICE_QUERY_TOKENS):
        return {}
    required_product_cols = {"id", "item_no", "product_name"}
    if not required_product_cols.issubset(set(product_columns)):
        return {}
    if not {"product_id", "price"}.issubset(set(price_columns)):
        return {}

    select_cols = ["p.`item_no` AS item_no", "p.`product_name` AS product_name", "pp.`price` AS price"]
    if "currency" in price_columns:
        select_cols.append("pp.`currency` AS currency")

    def _fetch(order: str) -> list[dict[str, Any]]:
        sql = (
            f"SELECT {', '.join(select_cols)} "
            "FROM products p "
            "JOIN product_prices pp ON pp.`product_id` = p.`id` "
            f"ORDER BY pp.`price` {order}, p.`id` DESC "
            "LIMIT :limit"
        )
        try:
            rows = db.execute(text(sql), {"limit": 8}).mappings().all()
        except SQLAlchemyError:
            return []

        deduped: list[dict[str, Any]] = []
        seen_item_nos: set[str] = set()
        for row in rows:
            item_no = str(row.get("item_no") or "").strip()
            if item_no and item_no in seen_item_nos:
                continue
            if item_no:
                seen_item_nos.add(item_no)
            compact = {
                key: _compact_prompt_value(value)
                for key, value in dict(row).items()
                if _compact_prompt_value(value) is not None
            }
            if compact:
                deduped.append(compact)
        return deduped[:5]

    expensive = _fetch("DESC")
    cheap = _fetch("ASC")
    result: dict[str, list[dict[str, Any]]] = {}
    if expensive:
        result["expensive_top5"] = expensive
    if cheap:
        result["cheap_top5"] = cheap
    return result


def _maybe_json(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    text_value = value.strip()
    if not text_value:
        return value
    if not (
        (text_value.startswith("{") and text_value.endswith("}"))
        or (text_value.startswith("[") and text_value.endswith("]"))
    ):
        return value
    try:
        return json.loads(text_value)
    except Exception:
        return value


def _nutrition_snapshot(
    db: Session,
    question: str,
    product_columns: list[str],
) -> dict[str, Any]:
    if not any(token in question for token in _NUTRITION_QUERY_TOKENS):
        return {}
    if not product_columns:
        return {}

    nutrition_columns = [
        col
        for col in product_columns
        if any(
            key in col.lower()
            for key in (
                "nutrition",
                "nutri",
                "kcal",
                "calorie",
                "protein",
                "carb",
                "fat",
                "sodium",
                "sugar",
            )
        )
    ]
    if not nutrition_columns:
        return {}

    matched_rows, terms = _query_catalog_products(
        db=db,
        question=question,
        product_columns=product_columns,
        limit=_MAX_CATALOG_MATCH_ROWS,
    )
    if not matched_rows:
        return {"nutrition_columns": nutrition_columns, "search_terms": terms, "products": []}

    payload_rows: list[dict[str, Any]] = []
    for row in matched_rows:
        compact: dict[str, Any] = {}
        for base_col in ("item_no", "product_name"):
            if base_col in product_columns:
                base_val = _compact_prompt_value(row.get(base_col))
                if base_val is not None:
                    compact[base_col] = base_val

        for col in nutrition_columns:
            raw_value = row.get(col)
            if raw_value is None:
                continue
            parsed = _maybe_json(raw_value)
            if isinstance(parsed, (dict, list)):
                compact[col] = parsed
                continue
            value = _compact_prompt_value(parsed)
            if value is not None:
                compact[col] = value

        if compact:
            payload_rows.append(compact)

    return {
        "nutrition_columns": nutrition_columns,
        "search_terms": terms,
        "products": payload_rows,
    }


def _build_catalog_context(db: Session, question: str) -> dict[str, Any]:
    product_columns = _table_columns(db, "products")
    if not product_columns:
        return {"available": False}

    price_columns = _table_columns(db, "product_prices")

    product_rows, terms = _query_catalog_products(db, question, product_columns, _MAX_CATALOG_MATCH_ROWS)
    matched_rows: list[dict[str, Any]] = []

    for row in product_rows:
        compact_row: dict[str, Any] = {}
        for col in product_columns:
            value = _compact_prompt_value(row.get(col))
            if value is not None:
                compact_row[col] = value

        product_id = row.get("id")
        if product_id is not None and price_columns:
            try:
                price_row = _latest_price_row(db, int(product_id), price_columns)
            except SQLAlchemyError:
                price_row = {}
            if price_row:
                compact_row["latest_price"] = _compact_prompt_value(price_row.get("price"))
                compact_row["latest_currency"] = _compact_prompt_value(price_row.get("currency"))
                compact_row["latest_price_source"] = _compact_prompt_value(price_row.get("source"))
                compact_row["latest_price_checked_at"] = _compact_prompt_value(price_row.get("checked_at"))

                # discount 컬럼이 product_prices에 통합됐으므로 price_row에서 직접 읽음
                for disc_col in ("is_discounted", "discount_rate", "discount_amount"):
                    val = _compact_prompt_value(price_row.get(disc_col))
                    if val is not None:
                        compact_row[disc_col] = val

        matched_rows.append({k: v for k, v in compact_row.items() if v is not None})

    context: dict[str, Any] = {
        "available": True,
        "schema": {
            "products": product_columns,
            "product_prices": price_columns,
        },
        "summary": _catalog_summary(db, product_columns, price_columns),
        "search_terms": terms,
        "matched_products": matched_rows[:_MAX_CATALOG_MATCH_ROWS],
        "corner_map": _category_corner_snapshot(db),
    }

    discount_rows = _discount_snapshot(db, question, product_columns, price_columns)
    if discount_rows:
        context["discount_snapshot"] = discount_rows

    price_rows = _price_snapshot(db, question, product_columns, price_columns)
    if price_rows:
        context["price_snapshot"] = price_rows

    nutrition_rows = _nutrition_snapshot(db, question, product_columns)
    if nutrition_rows:
        context["nutrition_snapshot"] = nutrition_rows

    nutrition_rank_rows = _nutrition_rank_snapshot(db, question, product_columns)
    if nutrition_rank_rows:
        context["nutrition_rank_snapshot"] = nutrition_rank_rows

    return context


# ---------------------------------------------------------------------------
# LLM answer generator
# ---------------------------------------------------------------------------

def _normalize_query_token(value: str) -> str:
    return re.sub(r"[^0-9a-z가-힣]+", "", (value or "").lower())


def _detect_requested_nutrients(question: str) -> list[str]:
    normalized_question = _normalize_query_token((question or "").lower())
    requested_nutrients: list[str] = []
    for nutrient_name, aliases in _NUTRIENT_ALIAS_MAP.items():
        normalized_aliases = [
            _normalize_query_token(alias)
            for alias in aliases
            if _normalize_query_token(alias)
        ]
        if normalized_aliases and any(alias in normalized_question for alias in normalized_aliases):
            requested_nutrients.append(nutrient_name)
    return requested_nutrients


def _is_nutrition_rank_query(question: str) -> bool:
    lowered = (question or "").lower()
    if not any(token in lowered for token in _NUTRITION_QUERY_TOKENS):
        return False
    return any(token in lowered for token in _NUTRITION_RANK_QUERY_TOKENS)


def _extract_category_terms_for_rank(question: str, max_terms: int = 3) -> list[str]:
    tokens = re.findall(r"[A-Za-z]{2,}|[가-힣]{2,}", question or "")
    nutrient_tokens = {
        _normalize_query_token(token)
        for token in _NUTRITION_QUERY_TOKENS
        if _normalize_query_token(token)
    }
    for aliases in _NUTRIENT_ALIAS_MAP.values():
        nutrient_tokens.update(
            _normalize_query_token(alias)
            for alias in aliases
            if _normalize_query_token(alias)
        )

    ranking_stopwords = {
        "제일",
        "가장",
        "높은",
        "낮은",
        "최고",
        "최저",
        "top",
        "탑",
        "순위",
        "랭킹",
        "카테고리",
        "카테고리별",
        "별",
        "상품",
        "제품",
        "알려",
        "알려줘",
        "뭐야",
        "무엇",
        "정보",
    }
    ranking_stopwords.update(_CATALOG_STOPWORDS)
    ranking_stopwords_norm = {
        _normalize_query_token(token)
        for token in ranking_stopwords
        if _normalize_query_token(token)
    }
    ranking_stopwords_norm.update(nutrient_tokens)

    terms: list[str] = []
    seen: set[str] = set()
    for token in tokens:
        normalized = _normalize_query_token(token)
        if not normalized:
            continue
        if normalized in ranking_stopwords_norm:
            continue
        if normalized in seen:
            continue
        seen.add(normalized)
        terms.append(token.strip())
        if len(terms) >= max_terms:
            break
    return terms


def _numeric_from_text(value: str) -> float | None:
    match = re.search(r"([0-9]+(?:\.[0-9]+)?)", value or "")
    if not match:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None


def _flatten_nutrition_pairs(value: Any, parent_key: str = "") -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    if isinstance(value, dict):
        for k, v in value.items():
            key = str(k).strip()
            if isinstance(v, (dict, list)):
                pairs.extend(_flatten_nutrition_pairs(v, key or parent_key))
            else:
                pairs.append((key or parent_key, str(v).strip()))
        return pairs
    if isinstance(value, list):
        for item in value:
            pairs.extend(_flatten_nutrition_pairs(item, parent_key))
        return pairs
    text_value = str(value).strip()
    if text_value:
        pairs.append((parent_key, text_value))
    return pairs


def _collect_nutrition_pairs(product_row: dict[str, Any]) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for key, raw_value in product_row.items():
        if key in {"item_no", "product_name"}:
            continue
        parsed = _maybe_json(raw_value)
        if isinstance(parsed, (dict, list)):
            pairs.extend(_flatten_nutrition_pairs(parsed, str(key)))
            continue
        value = str(parsed).strip()
        if value:
            pairs.append((str(key), value))
    return pairs


def _nutrition_rank_snapshot(
    db: Session,
    question: str,
    product_columns: list[str],
) -> dict[str, Any]:
    if not _is_nutrition_rank_query(question):
        return {}
    if not product_columns or "product_name" not in product_columns:
        return {}

    requested_nutrients = _detect_requested_nutrients(question)
    if not requested_nutrients:
        return {}
    target_nutrient = requested_nutrients[0]

    nutrition_columns = [
        col
        for col in product_columns
        if any(
            key in col.lower()
            for key in (
                "nutrition",
                "nutri",
                "kcal",
                "calorie",
                "protein",
                "carb",
                "fat",
                "sodium",
                "sugar",
            )
        )
    ]
    if not nutrition_columns:
        return {}

    category_cols = [col for col in ("category_s", "category_m", "category_l", "category") if col in product_columns]

    select_cols: list[str] = []
    for col in ("item_no", "product_name"):
        if col in product_columns:
            select_cols.append(f"p.`{col}`")
    for col in category_cols:
        select_cols.append(f"p.`{col}`")
    for col in nutrition_columns:
        alias = f"p.`{col}`"
        if alias not in select_cols:
            select_cols.append(alias)

    nutrition_exists = " OR ".join(
        f"(p.`{col}` IS NOT NULL AND TRIM(CAST(p.`{col}` AS CHAR)) <> '')"
        for col in nutrition_columns
    )
    where_parts = [f"({nutrition_exists})"]

    category_terms = _extract_category_terms_for_rank(question, max_terms=3)
    params: dict[str, Any] = {}
    if category_terms:
        for idx, term in enumerate(category_terms):
            key = f"cat_kw_{idx}"
            params[key] = f"%{term}%"
            term_clauses: list[str] = [f"p.`product_name` LIKE :{key}"]
            for col in category_cols:
                term_clauses.append(f"p.`{col}` LIKE :{key}")
            where_parts.append("(" + " OR ".join(term_clauses) + ")")

    order_parts: list[str] = []
    for col in ("updated_at", "created_at", "id"):
        if col in product_columns:
            order_parts.append(f"p.`{col}` DESC")
    if not order_parts:
        order_parts.append(f"p.`{product_columns[0]}` DESC")

    params["limit"] = 5000 if category_terms else 2000
    sql = (
        f"SELECT {', '.join(select_cols)} "
        "FROM products p "
        f"WHERE {' AND '.join(where_parts)} "
        f"ORDER BY {', '.join(order_parts)} "
        "LIMIT :limit"
    )

    try:
        rows = db.execute(text(sql), params).mappings().all()
    except SQLAlchemyError:
        return {}

    scored_rows: list[dict[str, Any]] = []
    for row in rows:
        row_dict = dict(row)
        nutrition_pairs = _collect_nutrition_pairs(row_dict)
        if not nutrition_pairs:
            continue

        nutrient_value = _extract_nutrient_value_from_pairs(
            nutrient_name=target_nutrient,
            aliases=_NUTRIENT_ALIAS_MAP[target_nutrient],
            pairs=nutrition_pairs,
        )
        if nutrient_value is None:
            continue
        nutrient_numeric = _numeric_from_text(nutrient_value)
        if nutrient_numeric is None:
            continue

        category_label = ""
        for col in ("category_s", "category_m", "category_l", "category"):
            value = str(row_dict.get(col) or "").strip()
            if value:
                category_label = value
                break

        scored_rows.append(
            {
                "item_no": str(row_dict.get("item_no") or "").strip(),
                "product_name": str(row_dict.get("product_name") or "").strip(),
                "category": category_label or "기타",
                "nutrient_value": nutrient_value,
                "nutrient_numeric": nutrient_numeric,
            }
        )

    if not scored_rows:
        return {}

    scored_rows.sort(key=lambda item: item.get("nutrient_numeric", 0), reverse=True)
    category_wise = "카테고리별" in (question or "") or "카테고리 별" in (question or "")

    if category_wise:
        best_by_category: dict[str, dict[str, Any]] = {}
        for row in scored_rows:
            category_key = str(row.get("category") or "기타").strip() or "기타"
            if category_key not in best_by_category:
                best_by_category[category_key] = row
        results = list(best_by_category.values())[:8]
    else:
        deduped: list[dict[str, Any]] = []
        seen_keys: set[str] = set()
        for row in scored_rows:
            key = str(row.get("item_no") or "").strip() or str(row.get("product_name") or "").strip()
            if not key or key in seen_keys:
                continue
            seen_keys.add(key)
            deduped.append(row)
            if len(deduped) >= 5:
                break
        results = deduped

    return {
        "target_nutrient": target_nutrient,
        "category_terms": category_terms,
        "category_wise": category_wise,
        "results": results,
    }


def _format_nutrient_value(key: str, value: str) -> str | None:
    cleaned = (value or "").strip().strip('"').strip("'")
    if not cleaned:
        return None
    number_match = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*(kcal|㎉|g|mg|ml|%)?", cleaned, flags=re.IGNORECASE)
    if not number_match:
        return cleaned

    number = number_match.group(1)
    unit = number_match.group(2)
    if unit:
        return f"{number}{unit}"

    key_unit = re.search(r"\(([^)]+)\)", key or "")
    if key_unit and key_unit.group(1).strip():
        return f"{number}{key_unit.group(1).strip()}"
    return number


def _extract_nutrient_value_from_pairs(
    nutrient_name: str,
    aliases: tuple[str, ...],
    pairs: list[tuple[str, str]],
) -> str | None:
    normalized_aliases = [_normalize_query_token(alias) for alias in aliases if _normalize_query_token(alias)]
    if not normalized_aliases:
        return None

    for key, value in pairs:
        key_norm = _normalize_query_token(key)
        if key_norm and any(alias in key_norm for alias in normalized_aliases):
            formatted = _format_nutrient_value(key, value)
            if formatted:
                return formatted

    combined = " | ".join(f"{k}:{v}" for k, v in pairs if k or v)
    for alias in aliases:
        alias_pattern = re.escape(alias)
        patterns = (
            rf"{alias_pattern}\s*(?:\([^)]*\))?\s*\"?\s*[:：]\s*\"?([0-9]+(?:\.[0-9]+)?\s*(?:kcal|㎉|g|mg|ml|%)?)",
            rf"{alias_pattern}\s*\"?\s*([0-9]+(?:\.[0-9]+)?\s*(?:kcal|㎉|g|mg|ml|%)?)",
        )
        for pattern in patterns:
            match = re.search(pattern, combined, flags=re.IGNORECASE)
            if match:
                return match.group(1).strip()
    return None


def _product_match_score(product_row: dict[str, Any], terms: list[str]) -> int:
    if not terms:
        return 0
    product_name = _normalize_query_token(str(product_row.get("product_name") or ""))
    item_no = _normalize_query_token(str(product_row.get("item_no") or ""))
    score = 0
    for term in terms:
        norm_term = _normalize_query_token(term)
        if not norm_term:
            continue
        if product_name.startswith(norm_term):
            score += 5
        elif norm_term in product_name:
            score += 3
        if item_no and norm_term == item_no:
            score += 4
    return score


def _is_location_query(question: str) -> bool:
    lowered = (question or "").lower()
    return any(token in lowered for token in _LOCATION_QUERY_TOKENS)


def _format_corner_label(corner_no: Any, corner_name: Any) -> str | None:
    try:
        no = int(corner_no)
    except (TypeError, ValueError):
        return None
    default_name = f"{no}번 코너"
    cleaned_name = str(corner_name or "").strip()
    if cleaned_name and cleaned_name != default_name:
        return f"{default_name} ({cleaned_name})"
    return default_name


def _answer_corner_location_direct(question: str, catalog_context: dict[str, Any] | None) -> str | None:
    if not _is_location_query(question):
        return None
    if not catalog_context or not catalog_context.get("available"):
        return "상품 위치 정보는 현재 DB에서 확인되지 않습니다."

    raw_corner_map = catalog_context.get("corner_map")
    if not isinstance(raw_corner_map, dict) or not raw_corner_map:
        return "카테고리-코너 매핑이 아직 등록되지 않았습니다."

    corner_map: dict[str, dict[str, Any]] = {
        str(k).strip(): v
        for k, v in raw_corner_map.items()
        if str(k).strip() and isinstance(v, dict)
    }
    if not corner_map:
        return "카테고리-코너 매핑이 아직 등록되지 않았습니다."

    normalized_question = _normalize_query_token(question)
    for category, info in corner_map.items():
        normalized_category = _normalize_query_token(category)
        if not normalized_category or normalized_category not in normalized_question:
            continue
        corner_label = _format_corner_label(info.get("corner_no"), info.get("corner_name"))
        if corner_label:
            return f"{category} 카테고리는 {corner_label}에 있습니다."

    raw_products = catalog_context.get("matched_products")
    if not isinstance(raw_products, list):
        return "질문하신 상품을 찾지 못했습니다."

    product_rows = [row for row in raw_products if isinstance(row, dict)]
    if not product_rows:
        return "질문하신 상품을 찾지 못했습니다."

    raw_terms = catalog_context.get("search_terms")
    terms = raw_terms if isinstance(raw_terms, list) else _extract_catalog_terms(question, limit=6)
    terms = [
        str(term).strip()
        for term in terms
        if _normalize_query_token(str(term)) not in _LOCATION_TERM_STOPWORDS
    ]
    scored_products = sorted(
        [
            (row, _product_match_score(row, terms))
            for row in product_rows
        ],
        key=lambda item: item[1],
        reverse=True,
    )

    resolved: list[str] = []
    seen_keys: set[str] = set()
    for row, score in scored_products:
        if terms and score <= 0:
            continue
        category = str(
            row.get("category_l")
            or row.get("category")
            or row.get("category_m")
            or row.get("category_s")
            or ""
        ).strip()
        if not category:
            continue

        mapping = corner_map.get(category)
        if not mapping:
            normalized_category = _normalize_query_token(category)
            for key, value in corner_map.items():
                if _normalize_query_token(key) == normalized_category:
                    mapping = value
                    category = key
                    break
        if not mapping:
            continue

        corner_label = _format_corner_label(mapping.get("corner_no"), mapping.get("corner_name"))
        if not corner_label:
            continue

        item_no = str(row.get("item_no") or "").strip()
        product_name = str(row.get("product_name") or item_no or "해당 상품").strip()
        dedup_key = item_no or product_name
        if dedup_key in seen_keys:
            continue
        seen_keys.add(dedup_key)
        resolved.append(f"{product_name}: {corner_label} (카테고리: {category})")
        if len(resolved) >= 3:
            break

    if not resolved:
        return "해당 상품의 코너 정보가 아직 등록되지 않았습니다."

    if len(resolved) == 1:
        first = resolved[0]
        product_part, right = first.split(": ", 1)
        return f"{product_part}은(는) {right}에 있습니다."

    return "확인된 상품 위치입니다.\n- " + "\n- ".join(resolved)


def _answer_nutrition_direct(question: str, catalog_context: dict[str, Any] | None) -> str | None:
    if not any(token in question for token in _NUTRITION_QUERY_TOKENS):
        return None
    if not catalog_context or not catalog_context.get("available"):
        return None

    nutrition_snapshot = catalog_context.get("nutrition_snapshot")
    if not isinstance(nutrition_snapshot, dict):
        return None

    raw_products = nutrition_snapshot.get("products")
    if not isinstance(raw_products, list):
        return "요청하신 상품의 영양 정보는 현재 DB에서 확인되지 않습니다."

    products = [row for row in raw_products if isinstance(row, dict)]
    if not products:
        return "요청하신 상품의 영양 정보는 현재 DB에서 확인되지 않습니다."

    rank_snapshot = catalog_context.get("nutrition_rank_snapshot")
    if isinstance(rank_snapshot, dict):
        rank_results = rank_snapshot.get("results")
        if isinstance(rank_results, list) and rank_results:
            target_nutrient = str(rank_snapshot.get("target_nutrient") or "영양소").strip()
            category_wise = bool(rank_snapshot.get("category_wise"))
            if category_wise:
                lines: list[str] = []
                for row in rank_results:
                    if not isinstance(row, dict):
                        continue
                    category = str(row.get("category") or "기타").strip() or "기타"
                    product_name = str(row.get("product_name") or "상품명 없음").strip()
                    nutrient_value = str(row.get("nutrient_value") or "").strip()
                    if nutrient_value:
                        lines.append(f"{category}: {product_name} ({nutrient_value})")
                if lines:
                    return f"카테고리별 {target_nutrient} 최고 상품입니다.\n- " + "\n- ".join(lines)

            top = rank_results[0] if isinstance(rank_results[0], dict) else {}
            if top:
                category_terms = rank_snapshot.get("category_terms")
                category_scope = ""
                if isinstance(category_terms, list):
                    tokens = [str(term).strip() for term in category_terms if str(term).strip()]
                    if tokens:
                        category_scope = f"{', '.join(tokens)} 기준 "
                product_name = str(top.get("product_name") or "상품명 없음").strip()
                nutrient_value = str(top.get("nutrient_value") or "").strip()
                if nutrient_value:
                    return f"{category_scope}{target_nutrient}가 가장 높은 상품은 {product_name} ({nutrient_value})입니다."

    search_terms = nutrition_snapshot.get("search_terms")
    terms = search_terms if isinstance(search_terms, list) else _extract_catalog_terms(question, limit=6)
    products = sorted(products, key=lambda row: _product_match_score(row, terms), reverse=True)

    requested_nutrients = _detect_requested_nutrients(question)

    if not requested_nutrients:
        first_product = products[0]
        product_name = str(first_product.get("product_name") or "해당 상품").strip()
        nutrition_pairs = _collect_nutrition_pairs(first_product)
        if not nutrition_pairs:
            return f"{product_name}의 영양 정보는 현재 DB에서 확인되지 않습니다."
        preview = ", ".join(
            f"{k}: {v}" if k else v
            for k, v in nutrition_pairs
            if (k or v)
        )
        if not preview:
            return f"{product_name}의 영양 정보는 현재 DB에서 확인되지 않습니다."
        return f"{product_name} 영양 정보: {preview}"

    answers: list[str] = []
    for product_row in products[:3]:
        product_name = str(product_row.get("product_name") or "해당 상품").strip()
        nutrition_pairs = _collect_nutrition_pairs(product_row)
        if not nutrition_pairs:
            continue
        found_parts: list[str] = []
        for nutrient_name in requested_nutrients:
            value = _extract_nutrient_value_from_pairs(
                nutrient_name=nutrient_name,
                aliases=_NUTRIENT_ALIAS_MAP[nutrient_name],
                pairs=nutrition_pairs,
            )
            if value is not None:
                found_parts.append(f"{nutrient_name}: {value}")
        if found_parts:
            answers.append(f"{product_name} 기준 {', '.join(found_parts)}")

    if answers:
        if len(answers) == 1:
            return f"{answers[0]}입니다."
        return "질문하신 영양 정보입니다.\n- " + "\n- ".join(answers)

    fallback_product = str(products[0].get("product_name") or "해당 상품").strip()
    return f"{fallback_product}의 {', '.join(requested_nutrients)} 정보는 현재 DB에서 확인되지 않습니다."


# ---------------------------------------------------------------------------
# Tool Use: tool definitions + execution helpers
# ---------------------------------------------------------------------------

CHATBOT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_products",
            "description": "상품을 키워드, 카테고리, 가격 범위로 검색합니다. 최대 8개 결과를 반환합니다.",
            "parameters": {
                "type": "object",
                "properties": {
                    "keyword": {"type": "string", "description": "상품명 검색어 (예: 새우깡, 콜라)"},
                    "category": {"type": "string", "description": "카테고리 (예: 과자, 면류, 음료)"},
                    "max_price": {"type": "integer", "description": "최대 가격 (원)"},
                    "only_discounted": {"type": "boolean", "description": "할인 상품만 검색", "default": False},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_product_detail",
            "description": "특정 상품의 가격, 할인, 영양정보 상세를 조회합니다.",
            "parameters": {
                "type": "object",
                "properties": {
                    "item_no": {"type": "string", "description": "상품번호"},
                    "product_name": {"type": "string", "description": "상품명 (상품번호 모를 때)"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_corner_location",
            "description": "상품 또는 카테고리의 매장 내 코너 위치를 조회합니다.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "상품명 또는 카테고리명"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_discount_ranking",
            "description": "카테고리별 할인율 높은 상품 순위를 조회합니다.",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "description": "카테고리 (예: 과자, 면류). 생략하면 전체."},
                    "limit": {"type": "integer", "description": "반환할 상품 수", "default": 5},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_nutrition_info",
            "description": "특정 상품의 영양정보(칼로리, 나트륨, 단백질 등)를 조회합니다.",
            "parameters": {
                "type": "object",
                "properties": {
                    "keyword": {"type": "string", "description": "상품명 또는 검색어"},
                    "nutrient": {"type": "string", "description": "특정 영양소 (칼로리, 나트륨, 단백질, 지방 등)"},
                    "rank_order": {"type": "string", "enum": ["highest", "lowest"], "description": "높은순/낮은순 정렬"},
                },
                "required": ["keyword"],
            },
        },
    },
]


def _tool_search_products(
    db: Session,
    keyword: str = "",
    category: str = "",
    max_price: int | None = None,
    only_discounted: bool = False,
) -> str:
    """search_products tool: DB에서 상품 검색 후 JSON 반환."""
    product_columns = _table_columns(db, "products")
    price_columns = _table_columns(db, "product_prices")
    if not product_columns:
        return json.dumps({"results": [], "message": "상품 테이블을 찾을 수 없습니다."}, ensure_ascii=False)

    # Build search query from keyword + category
    search_query = " ".join(filter(None, [keyword, category]))
    if not search_query.strip():
        search_query = "상품"

    product_rows, terms = _query_catalog_products(db, search_query, product_columns, _MAX_CATALOG_MATCH_ROWS)

    results: list[dict[str, Any]] = []
    seen_item_nos: set[str] = set()
    for row in product_rows:
        item_no = str(row.get("item_no") or "").strip()
        if item_no and item_no in seen_item_nos:
            continue
        if item_no:
            seen_item_nos.add(item_no)

        product_name = str(row.get("product_name") or "").strip()
        cat_l = str(row.get("category_l") or "").strip()

        # category filter
        if category and cat_l and category not in cat_l:
            cat_m = str(row.get("category_m") or "").strip()
            cat_s = str(row.get("category_s") or "").strip()
            if category not in cat_m and category not in cat_s and category not in product_name:
                continue

        # price lookup
        price_info: dict[str, Any] = {}
        product_id = row.get("id")
        if product_id is not None and price_columns:
            try:
                price_row = _latest_price_row(db, int(product_id), price_columns)
            except SQLAlchemyError:
                price_row = {}
            if price_row:
                price_info["price"] = price_row.get("price")
                price_info["currency"] = price_row.get("currency", "원")
                for disc_col in ("is_discounted", "discount_rate", "discount_amount"):
                    val = price_row.get(disc_col)
                    if val is not None:
                        price_info[disc_col] = val

        # max_price filter
        if max_price is not None and price_info.get("price") is not None:
            try:
                if int(price_info["price"]) > max_price:
                    continue
            except (TypeError, ValueError):
                pass

        # only_discounted filter
        if only_discounted and not price_info.get("is_discounted"):
            continue

        entry = {"item_no": item_no, "product_name": product_name}
        if cat_l:
            entry["category"] = cat_l
        entry.update(price_info)
        results.append(entry)

        if len(results) >= 8:
            break

    return json.dumps({"results": results, "count": len(results)}, ensure_ascii=False, default=str)


def _tool_get_product_detail(
    db: Session,
    item_no: str = "",
    product_name: str = "",
) -> str:
    """get_product_detail tool: 상품 상세 (가격, 할인, 영양정보) 조회."""
    product_columns = _table_columns(db, "products")
    price_columns = _table_columns(db, "product_prices")
    if not product_columns:
        return json.dumps({"error": "상품 테이블 없음"}, ensure_ascii=False)

    # Find the product
    row = None
    if item_no:
        try:
            row = db.execute(
                text("SELECT * FROM products WHERE item_no = :v LIMIT 1"),
                {"v": item_no},
            ).mappings().first()
        except SQLAlchemyError:
            pass
    if not row and product_name:
        try:
            row = db.execute(
                text("SELECT * FROM products WHERE product_name LIKE :v ORDER BY LENGTH(product_name) ASC LIMIT 1"),
                {"v": f"%{product_name}%"},
            ).mappings().first()
        except SQLAlchemyError:
            pass

    if not row:
        return json.dumps({"error": "해당 상품을 찾을 수 없습니다."}, ensure_ascii=False)

    row_dict = dict(row)
    result: dict[str, Any] = {
        "item_no": str(row_dict.get("item_no") or ""),
        "product_name": str(row_dict.get("product_name") or ""),
    }
    for col in ("category_l", "category_m", "category_s", "barcd", "company"):
        val = row_dict.get(col)
        if val and str(val).strip():
            result[col] = str(val).strip()

    # Price + discount
    product_id = row_dict.get("id")
    if product_id is not None and price_columns:
        try:
            price_row = _latest_price_row(db, int(product_id), price_columns)
        except SQLAlchemyError:
            price_row = {}
        if price_row:
            result["price"] = price_row.get("price")
            result["currency"] = price_row.get("currency", "원")
            for disc_col in ("is_discounted", "discount_rate", "discount_amount"):
                val = price_row.get(disc_col)
                if val is not None:
                    result[disc_col] = val

    # Nutrition
    nutrition_columns = [
        col for col in product_columns
        if any(key in col.lower() for key in ("nutrition", "nutri", "kcal", "calorie", "protein", "carb", "fat", "sodium", "sugar"))
    ]
    for col in nutrition_columns:
        raw = row_dict.get(col)
        if raw is not None:
            parsed = _maybe_json(raw)
            if parsed is not None:
                result[col] = parsed

    return json.dumps(result, ensure_ascii=False, default=str)


def _tool_get_corner_location(db: Session, query: str = "") -> str:
    """get_corner_location tool: 카테고리-코너 매핑 조회."""
    corner_map = _category_corner_snapshot(db)
    if not corner_map:
        return json.dumps({"error": "코너 매핑 정보가 등록되지 않았습니다."}, ensure_ascii=False)

    query_norm = query.strip().lower()

    # Direct category match
    for cat, info in corner_map.items():
        if query_norm in cat.lower() or cat.lower() in query_norm:
            return json.dumps({
                "category": cat,
                "corner_no": info["corner_no"],
                "corner_name": info.get("corner_name", f"{info['corner_no']}번 코너"),
            }, ensure_ascii=False)

    # Product name → category lookup
    product_columns = _table_columns(db, "products")
    if product_columns and "category_l" in product_columns:
        try:
            row = db.execute(
                text("SELECT category_l FROM products WHERE product_name LIKE :kw LIMIT 1"),
                {"kw": f"%{query}%"},
            ).mappings().first()
        except SQLAlchemyError:
            row = None
        if row:
            cat_l = str(row.get("category_l") or "").strip()
            if cat_l and cat_l in corner_map:
                info = corner_map[cat_l]
                return json.dumps({
                    "product_query": query,
                    "category": cat_l,
                    "corner_no": info["corner_no"],
                    "corner_name": info.get("corner_name", f"{info['corner_no']}번 코너"),
                }, ensure_ascii=False)

    return json.dumps({
        "message": f"'{query}'의 위치 정보를 찾을 수 없습니다.",
        "available_categories": list(corner_map.keys()),
    }, ensure_ascii=False)


def _tool_get_discount_ranking(
    db: Session,
    category: str = "",
    limit: int = 5,
) -> str:
    """get_discount_ranking tool: 할인율 높은 상품 조회."""
    product_columns = _table_columns(db, "products")
    price_columns = _table_columns(db, "product_prices")
    if not product_columns or not price_columns:
        return json.dumps({"results": []}, ensure_ascii=False)

    required = {"id", "item_no", "product_name"}
    if not required.issubset(set(product_columns)):
        return json.dumps({"results": []}, ensure_ascii=False)
    if not {"id", "product_id", "is_discounted"}.issubset(set(price_columns)):
        return json.dumps({"results": []}, ensure_ascii=False)

    select_cols = ["p.`item_no`", "p.`product_name`"]
    if "category_l" in product_columns:
        select_cols.append("p.`category_l`")
    if "discount_rate" in price_columns:
        select_cols.append("pp.`discount_rate`")
    if "discount_amount" in price_columns:
        select_cols.append("pp.`discount_amount`")
    if "price" in price_columns:
        select_cols.append("pp.`price`")

    where_parts = ["pp.`is_discounted` = 1"]
    params: dict[str, Any] = {"limit": max(1, min(limit, 20))}

    if category:
        cat_clauses = []
        params["cat_kw"] = f"%{category}%"
        for col in ("category_l", "category_m", "category_s"):
            if col in product_columns:
                cat_clauses.append(f"p.`{col}` LIKE :cat_kw")
        if cat_clauses:
            where_parts.append("(" + " OR ".join(cat_clauses) + ")")

    order_terms: list[str] = []
    if "discount_rate" in price_columns:
        order_terms.append("COALESCE(pp.`discount_rate`, 0) DESC")
    if "discount_amount" in price_columns:
        order_terms.append("COALESCE(pp.`discount_amount`, 0) DESC")
    order_terms.append("p.`id` DESC")

    sql = (
        f"SELECT {', '.join(select_cols)} "
        "FROM products p "
        "JOIN product_prices pp ON pp.`product_id` = p.`id` "
        f"WHERE {' AND '.join(where_parts)} "
        f"ORDER BY {', '.join(order_terms)} "
        "LIMIT :limit"
    )
    try:
        rows = db.execute(text(sql), params).mappings().all()
    except SQLAlchemyError:
        return json.dumps({"results": []}, ensure_ascii=False)

    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        item_no = str(row.get("item_no") or "").strip()
        if item_no and item_no in seen:
            continue
        if item_no:
            seen.add(item_no)
        entry: dict[str, Any] = {k: v for k, v in dict(row).items() if v is not None}
        results.append(entry)

    return json.dumps({"results": results, "count": len(results)}, ensure_ascii=False, default=str)


def _tool_get_nutrition_info(
    db: Session,
    keyword: str = "",
    nutrient: str = "",
    rank_order: str = "",
) -> str:
    """get_nutrition_info tool: 상품 영양정보 조회."""
    product_columns = _table_columns(db, "products")
    if not product_columns:
        return json.dumps({"error": "상품 테이블 없음"}, ensure_ascii=False)

    nutrition_columns = [
        col for col in product_columns
        if any(key in col.lower() for key in ("nutrition", "nutri", "kcal", "calorie", "protein", "carb", "fat", "sodium", "sugar"))
    ]
    if not nutrition_columns:
        return json.dumps({"error": "영양정보 컬럼이 없습니다."}, ensure_ascii=False)

    # Search products by keyword
    product_rows, terms = _query_catalog_products(db, keyword, product_columns, _MAX_CATALOG_MATCH_ROWS)
    if not product_rows:
        return json.dumps({"results": [], "message": f"'{keyword}' 관련 상품을 찾을 수 없습니다."}, ensure_ascii=False)

    results: list[dict[str, Any]] = []
    for row in product_rows[:8]:
        entry: dict[str, Any] = {
            "item_no": str(row.get("item_no") or ""),
            "product_name": str(row.get("product_name") or ""),
        }
        for col in nutrition_columns:
            raw = row.get(col)
            if raw is not None:
                parsed = _maybe_json(raw)
                if parsed is not None:
                    entry[col] = parsed
        results.append(entry)

    # If a specific nutrient + rank_order requested, sort
    if nutrient and rank_order and results:
        aliases = _NUTRIENT_ALIAS_MAP.get(nutrient)
        if not aliases:
            for name, alias_tuple in _NUTRIENT_ALIAS_MAP.items():
                if nutrient in alias_tuple or nutrient == name:
                    aliases = alias_tuple
                    break
        if aliases:
            scored: list[tuple[dict, float]] = []
            for entry in results:
                pairs = _collect_nutrition_pairs(entry)
                val = _extract_nutrient_value_from_pairs(nutrient, aliases, pairs)
                if val is not None:
                    num = _numeric_from_text(val)
                    if num is not None:
                        entry["_nutrient_value"] = val
                        scored.append((entry, num))
            scored.sort(key=lambda x: x[1], reverse=(rank_order == "highest"))
            results = [e for e, _ in scored]

    return json.dumps({"results": results, "count": len(results)}, ensure_ascii=False, default=str)


def _execute_tool(db: Session, tool_name: str, args: dict) -> str:
    """tool_call 실행 디스패처."""
    try:
        if tool_name == "search_products":
            return _tool_search_products(db, **args)
        elif tool_name == "get_product_detail":
            return _tool_get_product_detail(db, **args)
        elif tool_name == "get_corner_location":
            return _tool_get_corner_location(db, **args)
        elif tool_name == "get_discount_ranking":
            return _tool_get_discount_ranking(db, **args)
        elif tool_name == "get_nutrition_info":
            return _tool_get_nutrition_info(db, **args)
        else:
            return json.dumps({"error": f"Unknown tool: {tool_name}"}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": f"Tool execution error: {e}"}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# LLM call helper
# ---------------------------------------------------------------------------

def _is_local_llm() -> bool:
    """LM Studio / Ollama 등 로컬 LLM 서버인지 판별."""
    url = os.getenv("HF_CHAT_API", "http://localhost:1234/v1/chat/completions")
    return "localhost" in url or "127.0.0.1" in url


def _call_llm(
    messages: list[dict],
    tools: list[dict] | None = None,
) -> dict:
    """OpenAI-compatible LLM 호출. 로컬(LM Studio/Ollama) + 원격(HF Router) 모두 지원."""
    import logging
    logger = logging.getLogger("backend.chatbot")

    hf_model = os.getenv("HF_CHAT_MODEL", "gemma-4-4b")
    hf_api_url = os.getenv(
        "HF_CHAT_API", "http://localhost:1234/v1/chat/completions"
    )
    hf_token = _get_hf_token()
    is_local = _is_local_llm()

    if not hf_token and not is_local:
        raise RuntimeError(
            "HF_TOKEN이 설정되지 않았습니다. "
            "로컬 LLM을 사용하려면 HF_CHAT_API를 http://localhost:1234/v1/chat/completions 로 설정하세요."
        )

    # 로컬 서버는 인증 헤더 불필요
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if hf_token and not is_local:
        headers["Authorization"] = f"Bearer {hf_token}"

    payload: dict[str, Any] = {
        "model": hf_model,
        "messages": messages,
        "max_tokens": 800,
        "temperature": 0.4,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    try:
        resp = httpx.post(hf_api_url, headers=headers, json=payload, timeout=60.0)
    except httpx.ConnectError:
        raise RuntimeError(
            f"LLM 서버({hf_api_url})에 연결할 수 없습니다. "
            "LM Studio가 실행 중이고 서버가 시작되어 있는지 확인하세요."
        )

    # 400 + tools → tools 빼고 재시도
    if resp.status_code == 400 and tools:
        logger.warning("LLM 400 with tools, retrying without tools.")
        payload.pop("tools", None)
        payload.pop("tool_choice", None)
        cleaned = []
        for m in messages:
            if m.get("role") == "tool":
                continue
            if m.get("role") == "assistant" and m.get("tool_calls") and not (m.get("content") or "").strip():
                continue
            cleaned.append(m)
        payload["messages"] = cleaned
        resp = httpx.post(hf_api_url, headers=headers, json=payload, timeout=60.0)

    if resp.status_code in {404, 410}:
        raise RuntimeError(
            f"LLM 모델({hf_model})을 찾을 수 없습니다. "
            "LM Studio에서 모델이 로드되어 있는지 확인하세요."
        )
    if resp.status_code == 503:
        raise RuntimeError("LLM 모델이 아직 로딩 중입니다. 잠시 후 다시 시도해 주세요.")
    if resp.status_code == 400:
        try:
            detail = resp.json().get("error", resp.text[:300])
            if isinstance(detail, dict):
                detail = detail.get("message", str(detail))
        except Exception:
            detail = resp.text[:300]
        raise RuntimeError(f"LLM 오류(400): {detail}")
    if not is_local:
        if resp.status_code == 401:
            raise RuntimeError("HF_TOKEN 인증 실패.")
        if resp.status_code in {402, 403}:
            raise RuntimeError("HF 토큰 권한 문제. Inference Providers 권한을 확인하세요.")

    resp.raise_for_status()
    data = resp.json()

    if not isinstance(data, dict) or not isinstance(data.get("choices"), list) or not data["choices"]:
        if isinstance(data, dict) and "error" in data:
            raise RuntimeError(f"LLM 오류: {data['error']}")
        raise RuntimeError("LLM 응답을 해석할 수 없습니다.")

    return data


# ---------------------------------------------------------------------------
# Cart context builder (for system prompt)
# ---------------------------------------------------------------------------

def _build_cart_context_text(products: list[ProductMeta], total: dict[str, Any]) -> str:
    """장바구니 정보를 텍스트로 변환 (system prompt 삽입용)."""
    cart_lines: list[str] = []
    for item in products:
        price_str = f"{item.unit_price:,}원" if item.unit_price is not None else "가격 미등록"
        display = item.product_name or item.name
        cart_lines.append(
            f"- {display}: {item.quantity}개, 단가: {price_str}, 소계: {item.line_total:,}원"
        )
    cart_text = "\n".join(cart_lines) if cart_lines else "(장바구니 비어있음)"

    unpriced_text = ", ".join(total["unpriced_items"]) if total["unpriced_items"] else "없음"
    total_text = (
        f"총 수량: {total['total_count']}개, "
        f"총 금액: {total['total_price']:,}원, "
        f"가격 등록 상품: {total['priced_items']}종, "
        f"가격 미등록: {unpriced_text}"
    )
    return f"{cart_text}\n\n합계: {total_text}"


def _answer_question(
    question: str,
    products: list[ProductMeta],
    total: dict[str, Any],
    db: Session,
    chat_history: list[dict] | None = None,
) -> str:
    """LLM 답변 생성. 로컬 소형모델은 context-injection, 원격 대형모델은 Tool Use."""
    import logging
    logger = logging.getLogger("backend.chatbot")

    q = question.strip()
    if not q:
        return "질문을 입력해 주세요. 예: '총 금액 얼마야?'"

    # 로컬 소형 모델 → Tool Use 건너뛰고 바로 context-injection (안정적 + 빠름)
    if _is_local_llm():
        return _answer_question_with_context(q, products, total, db, chat_history)

    # --- 원격 대형 모델: Tool Use 시도 ---
    try:
        cart_context = _build_cart_context_text(products, total)
        system_content = SYSTEM_PROMPT + "\n\n## 현재 장바구니\n" + cart_context

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_content},
        ]
        if chat_history:
            messages.extend(chat_history)
        messages.append({"role": "user", "content": q})

        data = _call_llm(messages, tools=CHATBOT_TOOLS)
        choice = data["choices"][0]
        msg = choice["message"]

        tool_calls = msg.get("tool_calls")
        if not tool_calls:
            content = msg.get("content", "")
            if content and str(content).strip():
                return str(content).strip()
            raise RuntimeError("empty_response")

        # Tool Use 루프
        messages.append(msg)
        for tc in tool_calls:
            fn_name = tc["function"]["name"]
            try:
                fn_args = json.loads(tc["function"]["arguments"])
            except (json.JSONDecodeError, KeyError):
                fn_args = {}
            result = _execute_tool(db, fn_name, fn_args)
            messages.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": result,
            })

        for _ in range(_MAX_TOOL_ROUNDS - 1):
            data = _call_llm(messages, tools=CHATBOT_TOOLS)
            choice = data["choices"][0]
            msg = choice["message"]

            tool_calls = msg.get("tool_calls")
            if not tool_calls:
                content = msg.get("content", "")
                return str(content).strip() or "답변을 생성하지 못했습니다."

            messages.append(msg)
            for tc in tool_calls:
                fn_name = tc["function"]["name"]
                try:
                    fn_args = json.loads(tc["function"]["arguments"])
                except (json.JSONDecodeError, KeyError):
                    fn_args = {}
                result = _execute_tool(db, fn_name, fn_args)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": result,
                })

        for m in reversed(messages):
            if m.get("role") == "assistant" and m.get("content"):
                return str(m["content"]).strip()
        return "도구 호출이 반복되어 답변을 완료하지 못했습니다."

    except Exception as tool_err:
        logger.warning("Tool-use LLM failed (%s), falling back to context-injection.", tool_err)

    # --- 2차: Context-injection fallback (tools 사용 안 함) ---
    return _answer_question_with_context(q, products, total, db, chat_history)


def _answer_question_with_context(
    question: str,
    products: list[ProductMeta],
    total: dict[str, Any],
    db: Session,
    chat_history: list[dict] | None = None,
) -> str:
    """Tool 미지원 fallback: 기존 방식으로 DB context를 사전 빌드하여 LLM에 전달."""
    q = question.strip()
    cart_context = _build_cart_context_text(products, total)
    catalog_context = _build_catalog_context(db, q)

    catalog_text_parts: list[str] = []
    if catalog_context and catalog_context.get("available"):
        for key in ("matched_products", "discount_snapshot", "price_snapshot",
                     "nutrition_snapshot", "nutrition_rank_snapshot", "corner_map"):
            val = catalog_context.get(key)
            if val:
                catalog_text_parts.append(f"[{key}]\n{_json_for_prompt(val)}")

    catalog_text = "\n\n".join(catalog_text_parts) if catalog_text_parts else "검색 결과 없음"

    # 로컬 소형 모델: 간결한 프롬프트 + 구조적 context
    is_local = _is_local_llm()
    sys_prompt = SYSTEM_PROMPT_LOCAL if is_local else SYSTEM_PROMPT

    user_prompt = (
        f"## 장바구니 현황\n{cart_context}\n\n"
        f"## 질문 관련 상품 DB 검색 결과\n{catalog_text}\n\n"
        f"## 사용자 질문\n{q}\n\n"
        "위 DB 검색 결과를 기반으로 답변해주세요.\n"
        "- 검색 결과에 있는 상품 정보를 활용하세요.\n"
        "- 상품명에 포함된 브랜드, 중량 정보도 함께 안내하세요.\n"
        "- 가격은 쉼표와 '원' 단위를 붙여주세요."
    )

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": sys_prompt},
    ]
    if chat_history:
        # tool/tool_calls 관련 메시지 필터링
        for m in chat_history:
            role = m.get("role", "")
            if role == "tool":
                continue
            if role == "assistant" and m.get("tool_calls") and not m.get("content"):
                continue
            if role in ("user", "assistant", "system"):
                messages.append({"role": role, "content": str(m.get("content", ""))})
    messages.append({"role": "user", "content": user_prompt})

    try:
        data = _call_llm(messages, tools=None)
        content = data["choices"][0]["message"].get("content", "")
        return str(content).strip() or "답변을 생성하지 못했습니다."
    except RuntimeError as e:
        return str(e)
    except Exception as e:
        return f"LLM 호출 오류: {e}"


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------

@router.get("/chatbot/suggestions")
async def get_chatbot_suggestions(session_id: str | None = None):
    """Return a set of quick-action suggestion chips."""
    suggestions = [
        "과자 중에서 할인율이 제일 큰 상품이 뭐야?",
        "가장 많이 담긴 상품은 뭐야?",
        "코카콜라 위치가 어디야?",
    ]

    if session_id:
        session = app_state.session_manager.get(session_id)
        if session:
            items = list(session.state["billing_items"].keys())
            if items:
                suggestions.append(f"{items[0]} 가격 알려줘")

    return {"suggestions": suggestions[:4]}


@router.post("/chatbot/query")
async def query_chatbot(req: ChatbotRequest, db: Session = Depends(get_db)):
    """Process a natural-language question about the current cart."""
    billing_items: dict[str, int] = {}
    cart_update: dict[str, Any] | None = None
    session = None

    if req.session_id:
        session = app_state.session_manager.get(req.session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Session not found")
        billing_items = dict(session.state["billing_items"])

        if req.question.startswith(_SELECT_PREFIX):
            pending = session.state.get("chatbot_pending")
            chosen = req.question[len(_SELECT_PREFIX):].strip()
            if not pending:
                cart_update = {
                    "action": "add",
                    "item": None,
                    "quantity": 0,
                    "new_quantity": None,
                    "billing_items": billing_items,
                    "error": "선택할 상품이 없습니다.",
                }
            else:
                action = pending.get("action", "add")
                qty = int(pending.get("quantity", 1))
                session.state.pop("chatbot_pending", None)

                label = chosen
                product_name = pending.get("label_map", {}).get(chosen)

                current = billing_items.get(label, 0)
                if action == "add":
                    next_qty = current + qty
                else:
                    if current == 0:
                        cart_update = {
                            "action": action,
                            "item": product_name or label,
                            "quantity": qty,
                            "new_quantity": 0,
                            "billing_items": billing_items,
                            "error": "장바구니에 해당 상품이 없습니다.",
                        }
                        next_qty = 0
                    else:
                        next_qty = max(0, current - qty)

                if not cart_update:
                    if next_qty > 0:
                        billing_items[label] = next_qty
                    elif label in billing_items:
                        del billing_items[label]

                    session.state["billing_items"] = dict(billing_items)
                    session.state["chatbot_last_label"] = label
                    cart_update = {
                        "action": action,
                        "item": product_name or label,
                        "quantity": qty,
                        "new_quantity": next_qty,
                        "billing_items": billing_items,
                    }
        else:
            action = _detect_cart_action(req.question)
            if action == "clear":
                removed_items = dict(billing_items)
                billing_items = {}
                session.state["billing_items"] = {}
                session.state.pop("chatbot_pending", None)
                session.state.pop("chatbot_last_label", None)
                cart_update = {
                    "action": "clear",
                    "item": None,
                    "quantity": 0,
                    "new_quantity": 0,
                    "billing_items": billing_items,
                    "removed_items": removed_items,
                }
            elif action:
                qty, cleaned = _extract_quantity(req.question)
                require_in_cart = action == "remove"
                label = None
                product_name = None

                if action == "add":
                    label = _find_label_in_cart(cleaned, billing_items)
                    if label:
                        product_name = _label_display(label)
                    else:
                        label, product_name = _find_by_item_no(db, cleaned)
                else:
                    label, product_name = _find_cart_label(db, cleaned, billing_items, require_in_cart)

                if not label and action == "remove":
                    if any(token in req.question for token in _REFERENCE_TOKENS):
                        last_label = session.state.get("chatbot_last_label")
                        if last_label in billing_items:
                            label = last_label
                            product_name = _label_display(last_label)

                if label:
                    current = billing_items.get(label, 0)
                    if action == "add":
                        next_qty = current + qty
                    else:
                        next_qty = max(0, current - qty)

                    if next_qty > 0:
                        billing_items[label] = next_qty
                    elif label in billing_items:
                        del billing_items[label]

                    session.state["billing_items"] = dict(billing_items)
                    session.state["chatbot_last_label"] = label
                    cart_update = {
                        "action": action,
                        "item": product_name or label,
                        "quantity": qty,
                        "new_quantity": next_qty,
                        "billing_items": billing_items,
                    }
                else:
                    if action == "remove":
                        candidates = _find_cart_candidates(cleaned, billing_items)
                    else:
                        candidates = _find_candidate_products(db, cleaned)

                    if len(candidates) == 1:
                        chosen = candidates[0]
                        label = chosen["label"]
                        product_name = chosen["product_name"]
                        current = billing_items.get(label, 0)
                        next_qty = current + qty if action == "add" else max(0, current - qty)
                        if next_qty > 0:
                            billing_items[label] = next_qty
                        elif label in billing_items:
                            del billing_items[label]

                        session.state["billing_items"] = dict(billing_items)
                        session.state["chatbot_last_label"] = label
                        cart_update = {
                            "action": action,
                            "item": product_name,
                            "quantity": qty,
                            "new_quantity": next_qty,
                            "billing_items": billing_items,
                        }
                    elif len(candidates) > 1:
                        session.state["chatbot_pending"] = {
                            "action": action,
                            "quantity": qty,
                            "label_map": {c["label"]: c["product_name"] for c in candidates},
                        }
                        cart_update = {
                            "action": action,
                            "item": None,
                            "quantity": qty,
                            "new_quantity": None,
                            "billing_items": billing_items,
                            "candidates": candidates,
                        }
                    else:
                        error_msg = "상품을 찾을 수 없습니다."
                        if action == "remove":
                            error_msg = "장바구니에 해당 상품이 없습니다."
                        cart_update = {
                            "action": action,
                            "item": None,
                            "quantity": qty,
                            "new_quantity": None,
                            "billing_items": billing_items,
                            "error": error_msg,
                        }
            else:
                label, _ = _find_cart_label(db, req.question, billing_items, require_in_cart=True)
                if label:
                    session.state["chatbot_last_label"] = label

    products = _build_cart_meta(db, billing_items)
    total = _totals(products)
    if cart_update and cart_update.get("error"):
        answer = str(cart_update.get("error") or "해당 상품을 찾지 못했어요. 상품명을 조금 더 정확히 입력해 주세요.")
    elif cart_update and cart_update.get("action") == "clear":
        removed_items = cart_update.get("removed_items") or {}
        if removed_items:
            answer = "현재 장바구니를 비웠습니다."
        else:
            answer = "현재 장바구니가 이미 비어있습니다."
    elif cart_update and cart_update.get("candidates"):
        answer = "비슷한 상품이 여러 개 있어요. 아래에서 하나를 선택해 주세요."
    elif cart_update:
        verb = "추가" if cart_update["action"] == "add" else "제거"
        item_name = cart_update["item"] or "상품"
        answer = (
            f"{item_name} {cart_update['quantity']}개를 {verb}했습니다. "
            f"현재 총 수량은 {total['total_count']}개이고 총 금액은 {total['total_price']:,}원입니다."
        )
    else:
        # Phase 2: Tool Use 기반 에이전틱 호출 (catalog_context 사전 빌드 불필요)
        chat_history = session.state.get("chatbot_history", []) if req.session_id and session else []
        answer = _answer_question(req.question, products, total, db, chat_history)

    # 대화 히스토리 갱신 (cart action이 아닌 LLM 호출 시에만)
    if req.session_id and session and not cart_update:
        history = session.state.get("chatbot_history", [])
        history.append({"role": "user", "content": req.question})
        history.append({"role": "assistant", "content": answer})
        max_entries = _MAX_CHAT_HISTORY_TURNS * 2
        session.state["chatbot_history"] = history[-max_entries:]

    return {
        "answer": answer,
        "cart": {
            "items": [p.model_dump() for p in products],
            **total,
        },
        "cart_update": cart_update,
    }
