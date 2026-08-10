import json
import os
import re
import tomllib
import unittest
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[2]
INSTALL_ROOT = "zed_modules/opto-sync/opto-sync-clients"
EXPECTED_DEPENDENCY = {
    "package": "opto-sync/opto-sync-clients",
    "range": "^0.2.0",
    "installRoot": INSTALL_ROOT,
}
KNOWN_ADAPTERS = {
    "rust": ("opto-sync-client", "clients/rust"),
    "typescript": ("@opto-sync/client", "clients/ts"),
    "dart": ("opto_sync_client", "clients/dart"),
}


def load_contract():
    manifest = tomllib.loads((ROOT / ".zpkg.toml").read_text(encoding="utf-8"))
    lock = tomllib.loads((ROOT / ".zpkg.lock").read_text(encoding="utf-8"))
    profile = json.loads((ROOT / "opto-sync-adapter.json").read_text(encoding="utf-8"))
    return manifest, lock, profile


class OptoSyncWrapperE2E(unittest.TestCase):
    def test_dependency_release_gates_and_lock_provenance_fail_closed(self) -> None:
        manifest, lock, profile = load_contract()

        self.assertEqual(
            manifest["dependencies"]["opto-sync/opto-sync-clients"], "^0.2.0"
        )
        self.assertEqual(manifest["install"]["dir"], "zed_modules")
        self.assertEqual(profile["dependency"], EXPECTED_DEPENDENCY)
        self.assertEqual(profile["implementationIssue"], "DEN-1153")
        self.assertEqual(set(profile["releaseGates"]), {"DEN-309", "DEN-363"})

        packages = lock.get("package", [])
        if profile["releaseState"] == "blocked-until-certified-package-published":
            self.assertEqual(lock.get("version"), 1)
            self.assertEqual(packages, [])
        else:
            package = next(
                item
                for item in packages
                if item.get("org") == "opto-sync"
                and item.get("name") == "opto-sync-clients"
            )
            for field in (
                "version",
                "sha256",
                "size",
                "format",
                "vcs_tag",
                "vcs_commit",
                "source",
            ):
                self.assertTrue(package.get(field), f"missing lock field: {field}")
            self.assertRegex(package["sha256"], re.compile(r"^[0-9a-f]{64}$"))
            self.assertRegex(package["vcs_commit"], re.compile(r"^[0-9a-f]{40}$"))
            self.assertGreater(package["size"], 0)

        serialized = json.dumps(profile).lower()
        for mutable_reference in ("refs/heads/main", 'branch = "main"', "latest"):
            self.assertNotIn(mutable_reference, serialized)

    def test_native_adapter_and_bootstrap_boundaries_are_independent(self) -> None:
        _, _, profile = load_contract()

        self.assertEqual(
            profile["repository"],
            os.environ.get("GITHUB_REPOSITORY", "zed-pkg/zed-sync"),
        )
        self.assertEqual(profile["e2eRepository"], "zed-pkg/zed-e2e")
        for boundary, enabled in profile["bootstrapBoundary"].items():
            self.assertIs(enabled, True, f"bootstrap boundary must remain enabled: {boundary}")
        self.assertIs(profile["invariants"]["zedBootstrapIndependent"], True)

        for language, adapter in profile["nativeAdapters"].items():
            package, suffix = KNOWN_ADAPTERS[language]
            self.assertEqual(adapter["package"], package)
            self.assertTrue(adapter["path"].startswith(INSTALL_ROOT))
            self.assertTrue(adapter["path"].endswith(suffix))
            self.assertNotIn("..", PurePosixPath(adapter["path"]).parts)

    def test_registry_authorization_release_policy_and_rollback_remain_zed_owned(self) -> None:
        _, _, profile = load_contract()

        retained = " ".join(profile["wrapperRetains"]).lower()
        for boundary in (
            "package-domain envelopes",
            "compatibility apis",
            "registry authorization",
            "organization",
            "actor",
            "tenant mapping",
            "package/version validation",
            "release policy",
            "backend endpoint",
            "telemetry namespace",
            "error mapping",
            "product migrations",
            "compatibility fixtures",
            "rollback mapping",
        ):
            self.assertIn(boundary, retained)

        self.assertEqual(
            set(profile["productCollections"]),
            {"organizations", "packages", "package_versions", "release_channels", "installations"},
        )
        delegated = " ".join(profile["delegatesToOptoSync"]).lower()
        for forbidden_registry_policy in (
            "registry authorization",
            "tenant mapping",
            "package/version validation",
            "release policy",
            "rollback mapping",
        ):
            self.assertNotIn(forbidden_registry_policy, delegated)

        for invariant in (
            "renderLocalView",
            "realtimeIsWakeHint",
            "serverCursorIsAuthoritative",
            "mutableGitRefsForbidden",
            "removeBespokeCoreOnlyAfterParity",
            "zedBootstrapIndependent",
        ):
            self.assertIs(profile["invariants"].get(invariant), True)


if __name__ == "__main__":
    unittest.main()
