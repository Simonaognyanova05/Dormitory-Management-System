"""
University Dormitory Motivational Letter Evaluation API

Receives a text-based PDF containing a Bulgarian motivational letter,
extracts its text, sends it to Jev-1.13, and returns an evaluation.

IMPORTANT:
- The Jev request/response schema below follows the integration structure
  used in the accompanying prototype. Verify the exact field names and
  response envelope against your Jev account/API documentation.
- Eligibility is assessed only from claims in the letter. It is NOT proof
  of residence, property ownership, or university enrolment.
- Scanned/image-only PDFs need OCR; this prototype reports that no text
  could be extracted.
"""

import os
from typing import Any

import fitz  # PyMuPDF
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile

load_dotenv()

JEV_API_KEY = os.getenv("JEV_API_KEY")
JEV_API_URL = os.getenv(
    "JEV_API_URL",
    "https://api.defapi.org/api/v1/decisions",
)
JEV_MODEL = "typesafe/jev-1.13"

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB
MAX_PAGES = 20

app = FastAPI(
    title="University Dormitory Evaluation Service",
    description="Evaluates Bulgarian student motivational letters.",
    version="1.0.0",
)

SCORE_LEVELS = [
    "1 - Много слабо: критерият практически не е покрит.",
    "2 - Слабо: критерият е покрит в ограничена степен.",
    "3 - Задоволително: критерият е покрит частично или достатъчно.",
    "4 - Добро: критерият е покрит убедително.",
    "5 - Отлично: критерият е покрит изчерпателно и убедително.",
]

EVALUATION_CRITERIA = {
    "clarity": "Яснота на изложението",
    "motivation": "Мотивация",
    "necessity": "Аргументация на необходимостта",
    "compliance": "Съответствие с условията",
    "completeness": "Пълнота",
}

ELIGIBILITY_RULES = {
    "residence": {
        "name": "Местоживеене",
        "instructions": (
            "Определи дали според мотивационното писмо студентът "
            "е жител на населено място извън София. Ако информацията "
            "липсва или е неясна, избери unknown."
        ),
    },
    "parent_property": {
        "name": "Собственост на родителите",
        "instructions": (
            "Определи дали според мотивационното писмо нито един от "
            "родителите на студента не притежава недвижим имот в град "
            "София. Ако информацията липсва или е неясна, избери unknown."
        ),
    },
    "university": {
        "name": "Университет",
        "instructions": (
            "Определи дали студентът е записан в момента във висше "
            "училище, намиращо се в град София. Приема се всеки "
            "университет в София, а не само университетът, който "
            "управлява общежитието. Ако информацията липсва или е "
            "неясна, избери unknown."
        ),
    },
}

ELIGIBILITY_OPTIONS = {
    "met": "Условието е изпълнено според информацията в писмото.",
    "not_met": "Условието не е изпълнено според информацията в писмото.",
    "unknown": "Недостатъчно информация за определяне.",
}


def extract_pdf_text(pdf_bytes: bytes) -> str:
    """Extract selectable text from a PDF held in memory."""
    try:
        with fitz.open(stream=pdf_bytes, filetype="pdf") as document:
            if document.page_count > MAX_PAGES:
                raise HTTPException(
                    status_code=413,
                    detail=f"PDF exceeds the {MAX_PAGES}-page limit.",
                )

            extracted_text = "\n".join(
                page.get_text("text") for page in document
            ).strip()

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail="Invalid or unreadable PDF file.",
        ) from exc

    if not extracted_text:
        raise HTTPException(
            status_code=422,
            detail=(
                "No selectable text was found. The PDF may be scanned; "
                "OCR support is not included in this version."
            ),
        )

    return extracted_text


def build_jev_request(letter_text: str) -> dict[str, Any]:
    """Build the Jev request using the prototype question structure."""
    questions: dict[str, Any] = {}

    for key, criterion_name in EVALUATION_CRITERIA.items():
        questions[key] = {
            "type": "score",
            "instructions": (
                f"Оцени мотивационното писмо по критерий: "
                f"{criterion_name}. Оценявай само качеството и "
                "информацията в самото писмо. Не измисляй липсващи "
                "факти. Използвай скалата от 1 до 5."
            ),
            "criteria": SCORE_LEVELS,
        }

    for key, rule in ELIGIBILITY_RULES.items():
        questions[f"eligibility_{key}"] = {
            "type": "choice",
            "instructions": rule["instructions"],
            "criteria": ELIGIBILITY_OPTIONS,
        }

    return {
        "model": JEV_MODEL,
        "state": {
            "document_type": "Bulgarian student motivational letter",
            "document_text": letter_text,
            "evaluation_instructions": (
                "Документът е мотивационно писмо на български език "
                "за кандидатстване за студентско общежитие. Оценявай "
                "само наличните доказателства в текста. Не прави "
                "предположения за липсващи факти."
            ),
        },
        "questions": questions,
    }


async def evaluate_with_jev(letter_text: str) -> dict[str, Any]:
    if not JEV_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="JEV_API_KEY is not configured. Check your .env file.",
        )

    payload = build_jev_request(letter_text)
    headers = {
        "Authorization": f"Bearer {JEV_API_KEY}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=90.0) as client:
            response = await client.post(
                JEV_API_URL,
                json=payload,
                headers=headers,
            )
            response.raise_for_status()
            return response.json()

    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504,
            detail="Jev API request timed out.",
        ) from exc
    except httpx.HTTPStatusError as exc:
        # Do not return the provider's full response body: it may contain
        # sensitive data from the submitted motivational letter.
        raise HTTPException(
            status_code=502,
            detail=f"Jev API returned HTTP {exc.response.status_code}.",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail="Could not connect to Jev API.",
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail="Jev API did not return valid JSON.",
        ) from exc


def process_evaluation(jev_response: dict[str, Any]) -> dict[str, Any]:
    """
    Convert the prototype Jev response to the service response.

    This expects an 'answers' object containing score and choice answers.
    Adjust this adapter if the actual Jev response uses a different envelope.
    """
    answers = jev_response.get("answers")

    if not isinstance(answers, dict):
        raise HTTPException(
            status_code=502,
            detail=(
                "Unexpected Jev response: missing 'answers' object. "
                "Inspect the API response and update process_evaluation()."
            ),
        )

    scores: dict[str, Any] = {}

    for key, criterion_name in EVALUATION_CRITERIA.items():
        answer = answers.get(key)

        if not isinstance(answer, dict) or answer.get("type") != "score":
            raise HTTPException(
                status_code=502,
                detail=f"Missing or invalid Jev score for '{key}'.",
            )

        try:
            raw_score = float(answer["score"])
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Jev returned an invalid score for '{key}'.",
            ) from exc

        # This conversion assumes Jev returns scores on a 0-4 scale.
        # If Jev returns 1-5 directly, remove the +1 conversion.
        if not 0 <= raw_score <= 4:
            raise HTTPException(
                status_code=502,
                detail=(
                    f"Jev score for '{key}' was outside the expected "
                    "0-4 range. Check the model's score scale."
                ),
            )

        scores[key] = {
            "criterion": criterion_name,
            "score": round(raw_score + 1, 2),
            "confidence": answer.get("confidence"),
            "probabilities": answer.get("probabilities"),
        }

    eligibility: dict[str, Any] = {}

    for key, rule in ELIGIBILITY_RULES.items():
        answer = answers.get(f"eligibility_{key}")

        if not isinstance(answer, dict) or answer.get("type") != "choice":
            raise HTTPException(
                status_code=502,
                detail=f"Missing or invalid eligibility result: '{key}'.",
            )

        selected = answer.get("choice")
        if selected not in ELIGIBILITY_OPTIONS:
            raise HTTPException(
                status_code=502,
                detail=f"Unexpected eligibility choice for '{key}'.",
            )

        eligibility[key] = {
            "requirement": rule["name"],
            "status": selected,
            "description": ELIGIBILITY_OPTIONS[selected],
            "confidence": answer.get("confidence"),
        }

    statuses = [item["status"] for item in eligibility.values()]

    if "not_met" in statuses:
        eligibility_result = "not_eligible_according_to_letter"
    elif all(status == "met" for status in statuses):
        eligibility_result = "all_conditions_indicated_as_met"
    else:
        eligibility_result = "manual_review"

    overall_score = round(
        sum(item["score"] for item in scores.values()) / len(scores),
        2,
    )

    return {
        "evaluation": scores,
        "overall_score": overall_score,
        "eligibility": eligibility,
        "eligibility_result": eligibility_result,
        "jev_metadata": {
            "model": jev_response.get("model", JEV_MODEL),
            "task_id": jev_response.get("task_id"),
            "usage": jev_response.get("usage"),
        },
        "notice": (
            "This is an AI-assisted assessment of the letter only. "
            "Verify eligibility against official documents."
        ),
    }


@app.post("/evaluate")
async def evaluate_student_letter(file: UploadFile = File(...)):
    """Upload one PDF motivational letter and receive its evaluation."""
    filename = (file.filename or "").lower()

    if not filename.endswith(".pdf"):
        raise HTTPException(
            status_code=400,
            detail="Only PDF files are accepted.",
        )

    pdf_bytes = await file.read(MAX_FILE_SIZE + 1)
    await file.close()

    if len(pdf_bytes) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413,
            detail="Maximum PDF size is 10 MB.",
        )

    if not pdf_bytes.startswith(b"%PDF-"):
        raise HTTPException(
            status_code=400,
            detail="Uploaded file does not have a valid PDF signature.",
        )

    letter_text = extract_pdf_text(pdf_bytes)
    jev_response = await evaluate_with_jev(letter_text)
    return process_evaluation(jev_response)


@app.get("/health")
async def health_check():
    return {
        "status": "running",
        "service": "Dormitory Evaluation API",
        "model": JEV_MODEL,
    }
