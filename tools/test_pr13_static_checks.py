from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from tools import pr13_static_checks


ARCHITECTURE_FILES = [
    "src/lib/db/index.ts",
    "src/lib/db/migration-data-evidence.ts",
    "src/lib/db/migration-journal.ts",
    "src/lib/db/migration-baseline-approval.ts",
]

SETTINGS_ARCHITECTURE_FILES = [
    "src/app/[locale]/settings/page.tsx",
    "src/app/[locale]/settings/settings-page-client.tsx",
]


class SettingsBoundaryStaticChecksTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        for relative in SETTINGS_ARCHITECTURE_FILES:
            destination = self.root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(pr13_static_checks.ROOT / relative, destination)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def check(self) -> None:
        checker = getattr(pr13_static_checks, "check_settings_page_invariants", None)
        self.assertIsNotNone(checker, "settings page checker export is missing")
        checker(self.root)

    def test_current_server_client_boundary_passes(self) -> None:
        self.check()

    def test_server_wrapper_must_not_have_use_client_directive(self) -> None:
        page = self.root / "src/app/[locale]/settings/page.tsx"
        source = page.read_text(encoding="utf-8")
        page.write_text(
            '\ufeff  // leading comment\n/* boundary comment */\n  "use client";\n' + source,
            encoding="utf-8",
        )

        with self.assertRaisesRegex(AssertionError, "must remain a server component"):
            self.check()

    def test_non_directive_use_client_string_is_allowed(self) -> None:
        page = self.root / "src/app/[locale]/settings/page.tsx"
        source = page.read_text(encoding="utf-8")
        page.write_text(source + '\nconst diagnostic = "use client";\n', encoding="utf-8")

        self.check()

    def test_speech_capability_must_remain_in_the_client(self) -> None:
        client = self.root / "src/app/[locale]/settings/settings-page-client.tsx"
        source = client.read_text(encoding="utf-8")
        self.assertIn('capability="speech"', source)
        client.write_text(source.replace('capability="speech"', 'capability="text"', 1), encoding="utf-8")

        with self.assertRaisesRegex(AssertionError, "speech capability"):
            self.check()

    def test_server_wrapper_must_import_the_settings_client(self) -> None:
        page = self.root / "src/app/[locale]/settings/page.tsx"
        source = page.read_text(encoding="utf-8")
        self.assertIn('import { SettingsPageClient } from "./settings-page-client";', source)
        page.write_text(
            source.replace('import { SettingsPageClient } from "./settings-page-client";', "", 1),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(AssertionError, "import SettingsPageClient"):
            self.check()

    def test_server_wrapper_must_render_the_settings_client(self) -> None:
        page = self.root / "src/app/[locale]/settings/page.tsx"
        source = page.read_text(encoding="utf-8")
        self.assertIn("<SettingsPageClient", source)
        page.write_text(source.replace("<SettingsPageClient", "<main", 1), encoding="utf-8")

        with self.assertRaisesRegex(AssertionError, "render SettingsPageClient"):
            self.check()

    def test_settings_client_module_must_exist(self) -> None:
        client = self.root / "src/app/[locale]/settings/settings-page-client.tsx"
        client.unlink()

        with self.assertRaisesRegex(AssertionError, "settings client module is missing"):
            self.check()


class MigrationRecoveryStaticChecksTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        for relative in ARCHITECTURE_FILES:
            destination = self.root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(pr13_static_checks.ROOT / relative, destination)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def check(self) -> None:
        checker = getattr(pr13_static_checks, "check_migration_recovery_invariants", None)
        self.assertIsNotNone(checker, "migration recovery checker export is missing")
        checker(self.root)

    def test_current_architecture_passes_without_legacy_marker(self) -> None:
        self.assertNotIn("markers.indexOf(false)", (self.root / "src/lib/db/index.ts").read_text(encoding="utf-8"))
        self.check()

    def test_each_critical_architecture_signal_is_required(self) -> None:
        mutations = [
            ("src/lib/db/index.ts", "export type ValidatedMigrationBundle"),
            ("src/lib/db/index.ts", "validatedMigrationBundles"),
            ("src/lib/db/index.ts", "export function loadValidatedMigrationBundle"),
            ("src/lib/db/index.ts", "validateMigrationExecutionStatements"),
            ("src/lib/db/index.ts", "validatedMigrationBundles.has(bundle)"),
            ("src/lib/db/index.ts", "applyPendingMigrations(sqlite, bundle)"),
            ("src/lib/db/index.ts", "sqlite.transaction"),
            ("src/lib/db/index.ts", "validateRecordedMigrationJournal"),
            ("src/lib/db/index.ts", "insert.run"),
            ("src/lib/db/migration-journal.ts", "validateMigrationJournal"),
            ("src/lib/db/migration-journal.ts", "contiguous repository prefix"),
            ("src/lib/db/migration-journal.ts", "hash mismatch"),
            ("src/lib/db/migration-journal.ts", "Duplicate recorded migration timestamp"),
            ("src/lib/db/migration-data-evidence.ts", "migrationsRequiringDataEvidence"),
            ("src/lib/db/migration-data-evidence.ts", "validateDataPostconditionRegistry"),
            ("src/lib/db/migration-data-evidence.ts", "0051 dropped legacy shot columns"),
            ("src/lib/db/migration-data-evidence.ts", "0058 dropped its copy source"),
            ("src/lib/db/migration-data-evidence.ts", "unregistered data/destructive migration"),
            ("src/lib/db/migration-baseline-approval.ts", "securityPolicy.verifyParent"),
            ("src/lib/db/migration-baseline-approval.ts", "inspectArtifact(absoluteBackupPath)"),
            ("src/lib/db/migration-baseline-approval.ts", "sameIdentity(publishedIdentity"),
            ("src/lib/db/migration-baseline-approval.ts", "finalArtifact.manifest"),
            (
                "src/lib/db/migration-baseline-approval.ts",
                "Backup evidence does not match the locked live database state",
            ),
        ]
        for relative, signal in mutations:
            with self.subTest(signal=signal):
                file = self.root / relative
                original = file.read_text(encoding="utf-8")
                self.assertIn(signal, original)
                file.write_text(original.replace(signal, "REMOVED_INVARIANT"), encoding="utf-8")
                with self.assertRaises(AssertionError):
                    self.check()
                file.write_text(original, encoding="utf-8")

    def test_atomic_apply_requires_immediate_transaction(self) -> None:
        file = self.root / "src/lib/db/index.ts"
        original = file.read_text(encoding="utf-8")
        start = original.index("export function applyPendingMigrations")
        end = original.index("export function runMigrations", start)
        body = original[start:end]
        self.assertIn(").immediate()", body)
        file.write_text(original[:start] + body.replace(").immediate()", ")", 1) + original[end:], encoding="utf-8")
        with self.assertRaises(AssertionError):
            self.check()


if __name__ == "__main__":
    unittest.main()
