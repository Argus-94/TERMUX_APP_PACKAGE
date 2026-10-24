import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "audit-native-platform-java-jar-provenance.py"
SPEC = importlib.util.spec_from_file_location("native_platform_jar_audit", SCRIPT)
AUDIT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(AUDIT)


class GradleDryRunTaskParserTests(unittest.TestCase):
    def test_parses_executed_and_skipped_gradle_8_task_lines(self):
        output = """\
> Task :buildSrc:compileJava
> Task :buildSrc:compileGroovy NO-SOURCE
:native-platform:writeNativeVersionSources SKIPPED
:native-platform:compileJava SKIPPED
:native-platform:compileGroovy SKIPPED
:native-platform:processResources SKIPPED
:native-platform:classes SKIPPED
:native-platform:jar SKIPPED
BUILD SUCCESSFUL in 43s
"""
        self.assertEqual(
            AUDIT.parse_gradle_dry_run_tasks(output),
            [
                ":buildSrc:compileJava",
                ":buildSrc:compileGroovy",
                ":native-platform:writeNativeVersionSources",
                ":native-platform:compileJava",
                ":native-platform:compileGroovy",
                ":native-platform:processResources",
                ":native-platform:classes",
                ":native-platform:jar",
            ],
        )

    def test_strips_ansi_codes_around_task_lines(self):
        output = "\x1b[32m> Task :buildSrc:compileJava\x1b[0m\n\x1b[33m:native-platform:jar SKIPPED\x1b[0m\n"
        self.assertEqual(
            AUDIT.parse_gradle_dry_run_tasks(output),
            [":buildSrc:compileJava", ":native-platform:jar"],
        )

    def test_ignores_non_task_and_malformed_lines(self):
        output = "BUILD SUCCESSFUL\n:native-platform:jar not-a-gradle-status\nrandom text\n"
        self.assertEqual(AUDIT.parse_gradle_dry_run_tasks(output), [])


if __name__ == "__main__":
    unittest.main()
