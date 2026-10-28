import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().with_name("deploy-caddy-certificate.sh")
HOST = "sub2api.gapsee.com"


class CertificateDeploymentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.fixtures.cleanup)
        root = Path(cls.fixtures.name)
        cls.certificates = {}
        for name, host in (("old", HOST), ("renewed", HOST), ("wrong", "other.example")):
            cert, key = root / f"{name}.crt", root / f"{name}.key"
            subprocess.run(
                ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                 "-keyout", str(key), "-out", str(cert), "-days", "30",
                 "-subj", f"/CN={host}", "-addext", f"subjectAltName=DNS:{host}"],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            )
            cls.certificates[name] = (cert.read_bytes(), key.read_bytes())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.bin = root / "bin"
        self.bin.mkdir()
        self.volume = root / "volume"
        self.volume.mkdir()
        self.directory = self.volume / "origin-certificates"
        self.published = self.directory / f"{HOST}.pem"
        self.log = root / "podman.log"
        self.fail = root / "fail"
        self.env = os.environ.copy()
        self.env.update(PATH=f"{self.bin}{os.pathsep}{self.env['PATH']}",
                        TEST_VOLUME=str(self.volume), TEST_LOG=str(self.log),
                        TEST_FAIL=str(self.fail))
        self.fake("id", '''#!/bin/bash
case "$*" in
  -un) echo sub2api ;;
  -u) echo 12345 ;;
  *) exit 1 ;;
esac
''')
        self.fake("podman", '''#!/bin/bash
if [ "$1 $2" = "volume inspect" ]; then
  printf '%s\\n' "$TEST_VOLUME"
  exit 0
fi
if [ "$1 $2 $3" = "exec sub2api-caddy caddy" ]; then
  printf '%s\\n' "$*" >> "$TEST_LOG"
  [ ! -f "$TEST_FAIL" ] || [ "$(<"$TEST_FAIL")" != "$4" ]
  exit $?
fi
exit 1
''')
        if not shutil.which("flock"):
            self.fake("flock", "#!/bin/bash\nexit 0\n")

    def fake(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o755)

    def pem(self, name):
        return b"".join(self.certificates[name])

    def publish(self, data):
        return subprocess.run(["bash", str(SCRIPT), "--publish"], input=data,
                              env=self.env, capture_output=True)

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def expected_calls(self, reload=True):
        prefix = "exec sub2api-caddy caddy "
        calls = [prefix + "validate --config /etc/caddy/Caddyfile --adapter caddyfile"]
        if reload:
            calls.append(prefix + "reload --force --config /etc/caddy/Caddyfile --adapter caddyfile")
        return calls

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))

    def assert_clean(self):
        self.assertEqual(sorted(p.name for p in self.directory.iterdir()),
                         [".deploy.lock", self.published.name])

    def test_unrelated_lineage_is_noop(self):
        env = dict(self.env, RENEWED_LINEAGE="/tmp/unrelated")
        result = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True)
        self.assert_success(result)
        self.assertFalse(self.directory.exists())
        self.assertEqual(self.calls(), [])

    def test_valid_certificate_is_published_and_reloaded(self):
        self.assert_success(self.publish(self.pem("old")))
        self.log.unlink()
        with self.published.open("rb") as previous:
            self.assert_success(self.publish(self.pem("renewed")))
            self.assertEqual(previous.read(), self.pem("old"))
        self.assertEqual(self.published.read_bytes(), self.pem("renewed"))
        self.assertEqual(stat.S_IMODE(self.published.stat().st_mode), 0o600)
        self.assertEqual(self.calls(), self.expected_calls())
        self.assert_clean()

    def test_unchanged_certificate_does_not_reload_caddy(self):
        self.assert_success(self.publish(self.pem("old")))
        self.log.unlink()
        inode = self.published.stat().st_ino
        self.assert_success(self.publish(self.pem("old")))
        self.assertEqual(self.published.stat().st_ino, inode)
        self.assertEqual(self.calls(), [])
        self.assert_clean()

    def test_wrong_hostname_and_mismatched_key_leave_previous_certificate(self):
        self.assert_success(self.publish(self.pem("old")))
        bad_inputs = {
            "wrong hostname": self.pem("wrong"),
            "mismatched key": self.certificates["renewed"][0] + self.certificates["old"][1],
        }
        for label, data in bad_inputs.items():
            with self.subTest(label=label):
                self.log.unlink(missing_ok=True)
                result = self.publish(data)
                self.assertNotEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
                self.assertEqual(self.published.read_bytes(), self.pem("old"))
                self.assertEqual(self.calls(), [])
                self.assert_clean()

    def test_failure_restores_previous_and_retry_publishes(self):
        for stage in ("validate", "reload"):
            with self.subTest(stage=stage):
                self.fail.unlink(missing_ok=True)
                self.assert_success(self.publish(self.pem("old")))
                self.log.unlink()
                self.fail.write_text(stage)
                result = self.publish(self.pem("renewed"))
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.published.read_bytes(), self.pem("old"))
                self.assertEqual(self.calls(), self.expected_calls(reload=stage == "reload"))
                self.assert_clean()
                self.fail.unlink()
                self.log.unlink()
                self.assert_success(self.publish(self.pem("renewed")))
                self.assertEqual(self.published.read_bytes(), self.pem("renewed"))
                self.assertEqual(self.calls(), self.expected_calls())
                self.assert_clean()

    def test_first_publication_failure_removes_certificate(self):
        self.fail.write_text("validate")
        result = self.publish(self.pem("renewed"))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.published.exists())
        self.assertEqual(self.calls(), self.expected_calls(reload=False))
        self.assertEqual([p.name for p in self.directory.iterdir()], [".deploy.lock"])


if __name__ == "__main__":
    unittest.main()
