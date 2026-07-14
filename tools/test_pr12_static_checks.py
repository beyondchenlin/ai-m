#!/usr/bin/env python3
"""Focused unit tests for the PR-12 runtime static-check contract."""
from __future__ import annotations

import contextlib
import importlib
import io
import pathlib
import tempfile
import unittest
from unittest import mock

from tools import pr12_static_checks


class NodeEngineDerivationTests(unittest.TestCase):
    def test_derives_engine_range_from_stable_pin(self) -> None:
        cases = [
            ("22.16.0", ">=22.16.0 <23"),
            ("22.16.0\n", ">=22.16.0 <23"),
            ("22.16.0\r\n", ">=22.16.0 <23"),
            ("9.8.7", ">=9.8.7 <10"),
            ("99.0.1", ">=99.0.1 <100"),
        ]

        for pin, expected in cases:
            with self.subTest(pin=repr(pin)):
                self.assertEqual(pr12_static_checks.derive_node_engine(pin), expected)

    def test_rejects_non_exact_or_non_stable_pins(self) -> None:
        invalid_pins = [
            "\ufeff22.16.0",
            " 22.16.0",
            "22.16.0 ",
            "\n22.16.0",
            "22.16.0\n\n",
            "022.16.0",
            "22.016.0",
            "22.16.00",
            "22.16.0-rc.1",
            "22.16.0+build.1",
            "22.16",
            "22",
            "v22.16.0",
            "22.16.0 junk",
            "",
        ]

        for pin in invalid_pins:
            with self.subTest(pin=repr(pin)):
                with self.assertRaisesRegex(
                    ValueError,
                    "exact stable major\\.minor\\.patch",
                ):
                    pr12_static_checks.derive_node_engine(pin)


class RequiredFileReadTests(unittest.TestCase):
    def test_missing_file_adds_only_missing_diagnostic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            errors: list[str] = []
            contents = pr12_static_checks.read_required_file(
                pathlib.Path(directory), ".node-version", errors
            )

        self.assertIsNone(contents)
        self.assertEqual(errors, ["missing required file: .node-version"])

    def test_missing_node_pin_does_not_add_malformed_pin_diagnostic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            errors = pr12_static_checks.run_checks(pathlib.Path(directory))

        node_pin_errors = [error for error in errors if ".node-version" in error]
        self.assertEqual(node_pin_errors, ["missing required file: .node-version"])

    def test_read_failures_are_aggregated_without_exception_details(self) -> None:
        failures = [
            OSError("secret path\ncontrol detail"),
            UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid byte"),
        ]

        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                errors: list[str] = []
                with mock.patch.object(pathlib.Path, "read_text", side_effect=failure):
                    contents = pr12_static_checks.read_required_file(
                        pathlib.Path("unused"), "required.txt", errors
                    )

                self.assertIsNone(contents)
                self.assertEqual(errors, ["unable to read required file: required.txt"])


class NodeContractTests(unittest.TestCase):
    def test_malformed_pin_has_one_precise_diagnostic(self) -> None:
        errors: list[str] = []

        pr12_static_checks.check_node_engine(
            {"engines": {"node": ">=22.16.0 <23"}}, "22.16", errors
        )

        self.assertEqual(
            errors,
            [
                ".node-version must contain an exact stable major.minor.patch version; "
                "one final newline is allowed"
            ],
        )

    def test_engine_must_match_derived_range(self) -> None:
        errors: list[str] = []

        pr12_static_checks.check_node_engine(
            {"engines": {"node": ">=22.12.0 <25"}}, "22.16.0\n", errors
        )

        self.assertEqual(
            errors,
            ["Node engine range must match .node-version: >=22.16.0 <23"],
        )


class ImportSafetyTests(unittest.TestCase):
    def test_import_does_not_execute_checks(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()

        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            importlib.reload(pr12_static_checks)

        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
