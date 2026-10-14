"""A7 recipes: verifier/test-routing/role/source selection question builders."""

from __future__ import annotations

import pathlib
import sys

import pytest

SRC = pathlib.Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

from typesafe_jev.coding_questions import (  # noqa: E402
    role_selection_questions,
    source_selection_questions,
    next_test_questions,
    verifier_questions,
)


def test_verifier_questions_shape() -> None:
    questions = verifier_questions()
    assert questions["needs_independent_verification"]["type"] == "noul"
    criteria = questions["strongest_remaining_risk"]["criteria"]
    assert "none" in criteria and "unknown" in criteria
    assert len(criteria) >= 3


def test_next_test_questions_per_candidate_and_validate() -> None:
    questions = next_test_questions(["tests/test_a.py", "tests/test_b.py"])
    assert set(questions) == {"discriminates_1", "discriminates_2"}
    assert questions["discriminates_1"]["type"] == "noul"
    assert questions["discriminates_1"]["instructions"]["test"] == "tests/test_a.py"
    with pytest.raises(ValueError):
        next_test_questions([])
    with pytest.raises(ValueError):
        next_test_questions(["ok", ""])
    with pytest.raises(ValueError):
        next_test_questions([f"tests/test_{i}.py" for i in range(9)])


def test_role_selection_questions_validate() -> None:
    questions = role_selection_questions({"implementer": "writes code", "reviewer": "reviews code"})
    assert set(questions["best_role"]["criteria"]) == {"implementer", "reviewer", "none"}
    with pytest.raises(ValueError):
        role_selection_questions({})
    with pytest.raises(ValueError):
        role_selection_questions({"ok": "  "})


def test_source_selection_questions_bounded() -> None:
    questions = source_selection_questions(["src/a.py", "src/b.py"])
    assert set(questions) == {"source_1", "source_2"}
    assert questions["source_1"]["instructions"]["source"] == "src/a.py"
    with pytest.raises(ValueError):
        source_selection_questions([])
    with pytest.raises(ValueError):
        source_selection_questions([f"src/{i}.py" for i in range(9)])
