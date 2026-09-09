"""Етап 2 модуля «Їжа»: авто-підказка тегу через vision-запит до Claude.

Необов'язкова частина. Якщо немає ключа або пакета `anthropic`, хаб просто
працює без підказок — користувач тегує сам двома кнопками.
"""

from __future__ import annotations

import base64
import json
import logging
from typing import Any

from . import config

log = logging.getLogger(__name__)

_SCHEMA = {
    "type": "object",
    "properties": {
        "is_sweet": {
            "type": "boolean",
            "description": "Чи є на фото десерт, цукерки, випічка, солодкий напій або інші солодощі.",
        },
        "item": {
            "type": "string",
            "description": "Коротка назва страви українською, 1–4 слова.",
        },
        "confidence": {
            "type": "number",
            "description": "Впевненість від 0 до 1.",
        },
    },
    "required": ["is_sweet", "item", "confidence"],
    "additionalProperties": False,
}

_PROMPT = (
    "Це фото їжі з особистого щоденника харчування. Визнач, чи є на ньому солодке: "
    "десерт, цукерки, шоколад, випічка, морозиво, солодкий напій. "
    "Фрукти самі по собі солодким не рахуються. Якщо на фото не їжа — is_sweet = false, "
    "item = «не їжа», confidence близько 0."
)

_client: Any = None


def available() -> bool:
    return config.VISION_ENABLED


def _get_client() -> Any:
    global _client
    if _client is None:
        import anthropic  # імпорт усередині, щоб пакет лишався необов'язковим

        _client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY, max_retries=1, timeout=30.0)
    return _client


def suggest_tag(image_bytes: bytes, media_type: str = "image/jpeg") -> dict[str, Any] | None:
    """Повертає {'tag': 'sweet'|'plain', 'item': str, 'confidence': float} або None."""
    if not available():
        return None
    try:
        client = _get_client()
        response = client.messages.create(
            model=config.VISION_MODEL,
            max_tokens=2048,
            output_config={
                "effort": "low",
                "format": {"type": "json_schema", "schema": _SCHEMA},
            },
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": base64.standard_b64encode(image_bytes).decode("utf-8"),
                            },
                        },
                        {"type": "text", "text": _PROMPT},
                    ],
                }
            ],
        )
        if getattr(response, "stop_reason", None) == "refusal":
            log.warning("Vision: запит відхилено (%s)", getattr(response, "stop_details", None))
            return None
        text = next((b.text for b in response.content if b.type == "text"), None)
        if not text:
            return None
        data = json.loads(text)
        return {
            "tag": "sweet" if data.get("is_sweet") else "plain",
            "item": str(data.get("item") or "").strip()[:80],
            "confidence": float(data.get("confidence") or 0),
        }
    except Exception as exc:  # підказка ніколи не має ламати запис фото
        log.warning("Vision-підказка не спрацювала: %s", exc)
        return None
